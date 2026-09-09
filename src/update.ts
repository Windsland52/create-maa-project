import {
  mergePending,
  readProjectConfig,
  trackProjectPathForBackup,
  withProjectWriteLock,
  writeGeneratedFiles,
  writeProjectState,
} from './project.js'
import type { ProjectWriteOperation } from './project.js'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  DEFAULT_OCR_FILES,
  DEFAULT_OCR_MODEL_DIR,
  DEFAULT_OCR_SUBMODULE_ASSETS_DIR,
  DEFAULT_OCR_SUBMODULE_PATH,
  DEFAULT_OCR_SUBMODULE_URL,
  downloadDefaultOcrZip,
  downloadUrl,
  extractProjectArchiveAssets,
  downloadManifestAssets,
  downloadProjectManifestAssets,
  resolveProductAssetManifest,
  resolveOcrManifestFromEnvironment,
  resolveRuntimePlatform,
  writeDownloadedAssets,
  writeDownloadedProjectAssets,
  type AssetDownloader,
  type AssetManifestResolver,
  type DownloadProgressReporter,
  PYTHON_EMBED_VERSION,
  type ProductAssetManifestRequest,
  type ProductAssetManifestResolver,
} from './assets.js'
import { baseProjectFiles } from './templates.js'
import type { CliOptions, MaaProjectConfig, ManagedFileInput, OcrConfig, PendingItem, ScaffoldResult } from './types.js'
import {
  copyFileAtomic,
  exists,
  readText,
  sha256,
  stableJson,
  throwIfAborted,
  writeFileAtomic,
  writeText,
} from './utils.js'
import { projectControllerKinds } from './controllers.js'
import { enabledResourcePacks, hasDevTools, hasGithubAutomation, isAddonEnabled } from './features.js'
import { isUpdateTarget, type UpdateTarget } from './update-targets.js'
import { runCommand } from './command.js'

const SYNC_REQUIREMENTS_IN_SCRIPT = `from pathlib import Path
import tomllib

pyproject = tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))
dependencies = pyproject["project"]["dependencies"]
assert isinstance(dependencies, list) and all(isinstance(dependency, str) for dependency in dependencies)
content = "# Generated from [project].dependencies in pyproject.toml.\\n" + "\\n".join(dependencies) + "\\n"
Path("requirements.in").write_text(content, encoding="utf-8")
`

const UPDATE_PENDING: Record<UpdateTarget, PendingItem> = {
  schema: {
    kind: 'schema',
    reason: 'Schema baseline update is pending because schema downloads are not implemented locally yet.',
    command: 'create-maa-project --update schema',
  },
  maafw: {
    kind: 'maafw',
    reason: 'MaaFramework asset resolution is pending.',
    command: 'create-maa-project --update maafw',
  },
  'runtime:mfa': {
    kind: 'runtime',
    reason: 'MFAAvalonia runtime asset resolution is pending.',
    command: 'create-maa-project --update runtime:mfa',
  },
  'runtime:mxu': {
    kind: 'runtime',
    reason: 'MXU runtime asset resolution is pending.',
    command: 'create-maa-project --update runtime:mxu',
  },
  'ocr-models': {
    kind: 'ocr-model',
    reason: 'OCR model download is pending.',
    command: 'create-maa-project --update ocr-models',
  },
  'node-deps': {
    kind: 'node-deps',
    reason: 'Node dependencies need to be installed or refreshed locally.',
    command: 'create-maa-project --update node-deps',
  },
  'python-deps': {
    kind: 'python-deps',
    reason: 'Python dependencies need to be synchronized locally.',
    command: 'create-maa-project --update python-deps',
  },
  'python-runtime': {
    kind: 'python-runtime',
    reason: 'Python release runtime and Agent release dependencies are pending.',
    command: 'create-maa-project --update python-runtime',
  },
}

export type UpdateCommandRunner = (root: string, command: string, args: string[]) => Promise<void>
export type ProgressReporter = (message: string) => void

const updateOperation = Symbol('updateOperation')

type UpdateEnvironment = {
  commandRunner?: UpdateCommandRunner
  ocrManifestResolver?: AssetManifestResolver
  productManifestResolver?: ProductAssetManifestResolver
  assetDownloader?: AssetDownloader
  onProgress?: ProgressReporter
  onDownloadProgress?: DownloadProgressReporter
  root?: string
  operationCommand?: string
  signal?: AbortSignal
  [updateOperation]?: ProjectWriteOperation
}

export async function recordUpdateRequests(
  options: CliOptions,
  environment: UpdateEnvironment = {},
): Promise<ScaffoldResult> {
  throwIfAborted(environment.signal)
  const root = environment.root ?? process.cwd()
  const targets = [
    ...new Set(options.update.map(validateUpdateTarget)),
  ]
  if (!environment[updateOperation]) {
    return withProjectWriteLock(
      root,
      environment.operationCommand ?? process.argv.join(' '),
      (operation) => recordUpdateRequests(options, { ...environment, [updateOperation]: operation }),
      { clearStale: options.clearStaleLock },
    )
  }
  const config = await readProjectConfig(root)
  const commandRunner = environment.commandRunner ?? runCommand

  return withProjectWriteLock(
    root,
    environment.operationCommand ?? process.argv.join(' '),
    async (operation) => {
      throwIfAborted(environment.signal)
      const written = new Set<string>()
      const skipped: string[] = []
      let pendingToAdd: PendingItem[] = []

      for (const target of targets) {
        throwIfAborted(environment.signal)
        if (target === 'schema') {
          const result = await writeGeneratedFiles(root, schemaFilesForConfig(config), {
            force: true,
            backup: true,
          })
          for (const path of result.written) written.add(path)
          skipped.push(...result.skipped)
          continue
        }
        if (target === 'node-deps') {
          await trackProjectPathForBackup(root, 'node_modules')
          await trackProjectPathForBackup(root, 'pnpm-lock.yaml')
          await updateNodeDeps(root, commandRunner)
          if (await exists(join(root, 'pnpm-lock.yaml'))) written.add('pnpm-lock.yaml')
          continue
        }
        if (target === 'python-deps') {
          for (const path of [
            'requirements.in',
            'uv.lock',
            'requirements.txt',
          ]) {
            await trackProjectPathForBackup(root, path)
          }
          await updatePythonDeps(root, commandRunner)
          for (const path of [
            'uv.lock',
            'requirements.in',
            'requirements.txt',
          ]) {
            if (await exists(join(root, path))) written.add(path)
          }
          continue
        }
        if (target === 'python-runtime') {
          environment.onProgress?.('Synchronizing Python release runtime assets...')
          const result = await updatePythonRuntime(root, {
            ...createProjectAssetUpdateOptions(
              {
                product: 'Python',
                channel: 'latest',
              },
              environment,
            ),
            commandRunner,
          })
          if (!result) {
            pendingToAdd.push(remoteAssetPending(target))
            continue
          }
          for (const path of result.written) written.add(path)
          environment.onProgress?.('Python release runtime synchronized.')
          continue
        }
        if (target === 'maafw') {
          environment.onProgress?.('Resolving MaaFramework assets...')
          const result = await updateProjectAssets(
            root,
            createProjectAssetUpdateOptions(
              {
                product: 'MaaFramework',
                channel: config.maafw.channel,
                version: config.maafw.version ?? '',
              },
              environment,
            ),
          )
          if (!result) {
            pendingToAdd.push(remoteAssetPending(target))
            continue
          }
          for (const path of result.written) written.add(path)
          environment.onProgress?.('MaaFramework assets downloaded.')
          continue
        }
        if (target === 'runtime:mfa') {
          if (!config.runtime.mfa.enabled) {
            skipped.push('runtime:mfa (disabled in config)')
            continue
          }
          environment.onProgress?.('Resolving MFAAvalonia runtime assets...')
          const result = await updateProjectAssets(
            root,
            createProjectAssetUpdateOptions(
              {
                product: 'MFAAvalonia',
                channel: config.runtime.mfa.channel,
                version: config.runtime.mfa.version ?? '',
              },
              environment,
            ),
          )
          if (!result) {
            pendingToAdd.push(remoteAssetPending(target))
            continue
          }
          for (const path of result.written) written.add(path)
          environment.onProgress?.('MFAAvalonia runtime assets downloaded.')
          continue
        }
        if (target === 'runtime:mxu') {
          if (!config.runtime.mxu?.enabled) {
            skipped.push('runtime:mxu (disabled in config)')
            continue
          }
          environment.onProgress?.('Resolving MXU runtime assets...')
          const result = await updateProjectAssets(
            root,
            createProjectAssetUpdateOptions(
              {
                product: 'MXU',
                channel: config.runtime.mxu.channel,
                version: config.runtime.mxu.version ?? '',
              },
              environment,
            ),
          )
          if (!result) {
            pendingToAdd.push(remoteAssetPending(target))
            continue
          }
          for (const path of result.written) written.add(path)
          environment.onProgress?.('MXU runtime assets downloaded.')
          continue
        }
        if (target === 'ocr-models') {
          if (config.ocr?.source === 'submodule') {
            environment.onProgress?.('Copying OCR models from submodule...')
            const subPath = config.ocr.submodulePath
            if (!subPath) {
              throw new Error('ocr.submodulePath is required when ocr.source is "submodule"')
            }
            await ensureOcrSubmoduleReady(root, config.ocr, {
              commandRunner,
              ...(environment.onProgress ? { onProgress: environment.onProgress } : {}),
              ...(environment.signal ? { signal: environment.signal } : {}),
            })
            const projectRoot = await realpath(root)
            const subRoot = await resolveContainedExistingPath(projectRoot, subPath, 'ocr.submodulePath')
            const ocrDest = resolve(projectRoot, 'resource/base/model/ocr')
            await trackProjectPathForBackup(root, 'resource/base/model/ocr')
            await mkdir(ocrDest, { recursive: true })
            const resolvedOcrDest = await realpath(ocrDest)
            assertPathWithin(projectRoot, resolvedOcrDest, 'OCR destination')
            if (config.ocr.files) {
              for (const [destName, srcRel] of Object.entries(config.ocr.files)) {
                assertSafeRelativePath(destName, 'ocr.files destination', { allowNested: false })
                const source = await resolveContainedExistingPath(subRoot, srcRel, `ocr.files["${destName}"]`)
                if (!(await stat(source)).isFile()) {
                  throw new Error(`ocr.files["${destName}"] must reference a file inside the OCR submodule.`)
                }
                await trackProjectPathForBackup(root, `resource/base/model/ocr/${destName}`)
                await copyFileAtomic(source, resolve(resolvedOcrDest, destName))
                written.add(['resource/base/model/ocr', destName].join('/'))
              }
            } else {
              await assertTreeContainsNoSymlinks(subRoot)
              await assertTreeContainsNoSymlinks(resolvedOcrDest)
              await rm(resolvedOcrDest, { force: true, recursive: true })
              await mkdir(resolvedOcrDest, { recursive: true })
              await cp(subRoot, resolvedOcrDest, { recursive: true, force: true, verbatimSymlinks: true })
              written.add('resource/base/model/ocr')
            }
            environment.onProgress?.('OCR models copied from submodule.')
            if (await syncOcrGitignoreForSource(root, 'submodule')) {
              written.add('.gitignore')
              environment.onProgress?.('Updated .gitignore for submodule-sourced OCR models.')
            }
            continue
          }
          environment.onProgress?.('Downloading OCR models...')
          const result = await updateOcrModels(root, createOcrUpdateOptions(environment))
          if (!result) {
            pendingToAdd.push(toPendingUpdate(target))
            continue
          }
          for (const path of result.written) written.add(path)
          if (await syncOcrGitignoreForSource(root, 'download')) {
            written.add('.gitignore')
            environment.onProgress?.('Updated .gitignore for downloaded OCR models.')
          }
          environment.onProgress?.('OCR models downloaded.')
          continue
        }
        pendingToAdd.push(toPendingUpdate(target))
      }

      throwIfAborted(environment.signal)
      pendingToAdd = mergePending([], pendingToAdd)
      await writeProjectState(root, config)
      written.add('maa-project.json')
      return {
        root,
        config,
        written: [
          ...written,
        ],
        skipped,
        pending: pendingToAdd,
        backupId: operation.backupId,
      }
    },
    { clearStale: options.clearStaleLock },
  )
}

function validateUpdateTarget(target: string): UpdateTarget {
  if (target === 'all') {
    throw new Error('--update all is not supported. Update one target at a time.')
  }
  if (!isUpdateTarget(target)) {
    throw new Error(`Unsupported update target: ${target}`)
  }
  return target
}

const RUNTIME_ASSET_PATH_PREFIXES = [
  '.create-maa-project/runtime/',
  'runtimes/',
  'libs/',
  'plugins/',
]
const PROJECT_ASSET_INSTALLATIONS_DIR = '.create-maa-project/runtime/installations/'

function embeddedPythonExecutable(platform: string): string {
  return platform.startsWith('win-')
    ? `.create-maa-project/runtime/python/${platform}/python.exe`
    : `.create-maa-project/runtime/python/${platform}/bin/python3`
}

function toPendingUpdate(target: UpdateTarget): PendingItem {
  return UPDATE_PENDING[target]
}

function remoteAssetPending(target: UpdateTarget): PendingItem {
  const pending = toPendingUpdate(target)
  return {
    ...pending,
    reason: `${pending.reason} No compatible GitHub release asset or explicit manifest was found.`,
  }
}

async function updateNodeDeps(root: string, commandRunner: UpdateCommandRunner): Promise<void> {
  await commandRunner(root, 'pnpm', [
    'install',
    '--ignore-scripts',
    '--ignore-pnpmfile',
    '--ignore-workspace',
    '--lockfile-dir',
    '.',
    '--modules-dir',
    'node_modules',
    '--virtual-store-dir',
    resolve(root, 'node_modules/.pnpm'),
  ])
}

async function updatePythonDeps(root: string, commandRunner: UpdateCommandRunner): Promise<void> {
  if (!(await exists(join(root, 'pyproject.toml')))) {
    throw new Error('--update python-deps requires an Agent project with pyproject.toml.')
  }
  for (const relativePath of ['requirements.in', 'uv.lock', 'requirements.txt']) {
    const path = join(root, relativePath)
    if (await exists(path)) await copyFileAtomic(path, path)
  }
  const syncScriptRoot = await mkdtemp(join(tmpdir(), `create-maa-project-python-deps-${randomUUID()}-`))
  const syncScriptPath = join(syncScriptRoot, 'sync-requirements-in.py')
  await writeFile(syncScriptPath, SYNC_REQUIREMENTS_IN_SCRIPT, 'utf8')
  try {
    await commandRunner(root, 'uv', [
      'run',
      '--no-project',
      '--python',
      '3.13',
      'python',
      syncScriptPath,
    ])
  } finally {
    await rm(syncScriptRoot, { force: true, recursive: true })
  }
  await commandRunner(root, 'uv', [
    'lock',
  ])
  await commandRunner(root, 'uv', [
    'export',
    '--format',
    'requirements-txt',
    '--no-hashes',
    '--no-emit-project',
    '--no-group',
    'dev',
    '--no-annotate',
    '--output-file',
    'requirements.txt',
  ])

  const requirementsPath = join(root, 'requirements.txt')
  const requirements = await readText(requirementsPath)
  const lines = requirements.split('\n')
  const headerEnd = lines.findIndex((line) => !line.startsWith('#'))
  lines.splice(headerEnd < 0 ? lines.length : headerEnd, 0, '# Dependabot: use --universal when updating this file.')
  await writeFileAtomic(requirementsPath, lines.join('\n'))
}

async function updatePythonRuntime(
  root: string,
  options: {
    request: ProductAssetManifestRequest
    allowedPathPrefixes: string[]
    manifestResolver: ProductAssetManifestResolver
    commandRunner: UpdateCommandRunner
    downloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
    signal?: AbortSignal
  },
): Promise<{ written: string[] } | undefined> {
  throwIfAborted(options.signal)
  if (!(await exists(join(root, 'pyproject.toml')))) {
    throw new Error('--update python-runtime requires an Agent project with pyproject.toml.')
  }
  if (!(await exists(join(root, 'requirements.txt')))) {
    throw new Error('--update python-runtime requires requirements.txt. Run --update python-deps first.')
  }

  const platform = resolveRuntimePlatform(options.request.platform)
  if (!platform || platform === 'all') {
    throw new Error(
      '--update python-runtime requires exactly one runtime platform because Agent dependencies are installed into a platform-specific Python runtime. Set CREATE_MAA_PROJECT_RUNTIME_PLATFORM=<os>-<arch>.',
    )
  }
  if (platform.startsWith('linux-')) {
    return updateLinuxPythonRuntime(root, platform, options.commandRunner)
  }
  if (platform.startsWith('win-')) {
    return updateWindowsEmbeddedPythonRuntime(root, platform, options)
  }

  const manifest = await options.manifestResolver({ ...options.request, platform })
  throwIfAborted(options.signal)
  if (!manifest) return undefined
  const runtimeRoot = `.create-maa-project/runtime/python/${platform}`
  const assets = await downloadProjectManifestAssets(
    manifest,
    options.downloader
      ? {
          downloader: options.downloader,
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        }
      : {
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
  )
  throwIfAborted(options.signal)
  const reserved = assets.find((asset) => asset.path.startsWith(PROJECT_ASSET_INSTALLATIONS_DIR))
  if (reserved) {
    throw new Error(`Project asset path is reserved for installation state: ${reserved.path}`)
  }
  await trackProjectPathForBackup(root, runtimeRoot)
  await rm(join(root, runtimeRoot), {
    recursive: true,
    force: true,
  })
  for (const asset of assets) await trackProjectPathForBackup(root, asset.path)
  const written = await writeDownloadedProjectAssets(root, assets)
  const python = await ensureEmbeddedPythonExecutable(root, platform)
  await options.commandRunner(root, 'uv', [
    'pip',
    'install',
    '--python',
    python,
    '--system',
    '--requirement',
    'requirements.txt',
  ])
  return {
    written: [
      ...written,
      python,
    ],
  }
}

async function updateWindowsEmbeddedPythonRuntime(
  root: string,
  platform: string,
  options: {
    commandRunner: UpdateCommandRunner
    downloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
    signal?: AbortSignal
  },
): Promise<{ written: string[] }> {
  const runtimeRoot = `.create-maa-project/runtime/python/${platform}`
  const arch = platform.endsWith('-arm64') ? 'arm64' : 'amd64'
  const filename = `python-${PYTHON_EMBED_VERSION}-embed-${arch}.zip`
  const url = `https://www.python.org/ftp/python/${PYTHON_EMBED_VERSION}/${filename}`
  const archive = await downloadRuntimeArchive(url, options.downloader, options.onDownloadProgress, options.signal)
  throwIfAborted(options.signal)
  const assets = patchWindowsEmbeddedPythonAssets(
    platform,
    extractProjectArchiveAssets(archive, {
      path: `.create-maa-project/runtime/python/${platform}/${filename}`,
      url,
      sha256: sha256(archive),
      size: archive.byteLength,
      extract: {
        product: 'Python',
        platform,
        format: 'zip',
      },
    }),
  )
  await trackProjectPathForBackup(root, runtimeRoot)
  await rm(join(root, runtimeRoot), {
    recursive: true,
    force: true,
  })
  const written = await writeDownloadedProjectAssets(root, assets)
  const python = await ensureEmbeddedPythonExecutable(root, platform)
  await options.commandRunner(root, 'uv', [
    'pip',
    'install',
    '--python',
    python,
    '--system',
    '--requirement',
    'requirements.txt',
  ])
  return {
    written: [
      ...written,
      python,
    ],
  }
}

async function ensureEmbeddedPythonExecutable(root: string, platform: string): Promise<string> {
  const python = embeddedPythonExecutable(platform)
  if (await exists(join(root, python))) {
    await chmod(join(root, python), 0o755)
    return python
  }
  if (!platform.startsWith('osx-')) {
    throw new Error(`Embedded Python executable is missing after extraction: ${python}`)
  }

  const binPath = `.create-maa-project/runtime/python/${platform}/bin`
  const candidate = await findPythonExecutableCandidate(root, binPath)
  if (!candidate) {
    throw new Error(`Embedded Python executable is missing after extraction: ${python}`)
  }
  await copyFileAtomic(join(root, binPath, candidate), join(root, python))
  await chmod(join(root, python), 0o755)
  return python
}

async function findPythonExecutableCandidate(root: string, binPath: string): Promise<string | undefined> {
  if (!(await exists(join(root, binPath)))) return undefined
  for (const name of [
    'python3.13',
    'python3.13t',
    'python',
  ]) {
    if (await exists(join(root, binPath, name))) return name
  }
  return (await readdir(join(root, binPath))).find((name) => /^python3(?:\.\d+)?$/.test(name))
}

async function updateLinuxPythonRuntime(
  root: string,
  platform: string,
  commandRunner: UpdateCommandRunner,
): Promise<{ written: string[] }> {
  const depsPath = `.create-maa-project/runtime/python-deps/${platform}`
  const stagingRoot = await mkdtemp(join(tmpdir(), `create-maa-project-python-runtime-${randomUUID()}-`))
  try {
    await commandRunner(root, 'python3', [
      '-m',
      'pip',
      'download',
      '--requirement',
      'requirements.txt',
      '--dest',
      stagingRoot,
      '--only-binary=:all:',
      ...linuxWheelPlatformArgs(platform),
    ])
    await trackProjectPathForBackup(root, depsPath)
    await rm(join(root, depsPath), {
      recursive: true,
      force: true,
    })
    await cp(stagingRoot, join(root, depsPath), { recursive: true, force: true })
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
  return {
    written: await listRelativeFiles(root, depsPath),
  }
}

async function downloadRuntimeArchive(
  url: string,
  downloader?: AssetDownloader,
  onDownloadProgress?: DownloadProgressReporter,
  signal?: AbortSignal,
): Promise<Buffer> {
  const options = {
    ...(onDownloadProgress ? { onProgress: onDownloadProgress } : {}),
    ...(signal ? { signal } : {}),
  }
  return downloader ? downloader(url, options) : downloadUrl(url, options)
}

function patchWindowsEmbeddedPythonAssets(
  platform: string,
  assets: ReturnType<typeof extractProjectArchiveAssets>,
): ReturnType<typeof extractProjectArchiveAssets> {
  const pthPath = `.create-maa-project/runtime/python/${platform}/`
  const index = assets.findIndex(
    (asset) => asset.path.startsWith(pthPath) && /^python\d*\._pth$/i.test(asset.path.split('/').at(-1) ?? ''),
  )
  if (index < 0) {
    throw new Error(`Windows embedded Python archive is missing python*._pth for ${platform}.`)
  }
  const asset = assets[index]
  if (!asset) return assets
  const content = patchWindowsPythonPth(asset.content.toString('utf8'))
  const nextContent = Buffer.from(content, 'utf8')
  assets[index] = {
    ...asset,
    content: nextContent,
    sha256: sha256(nextContent),
    size: nextContent.byteLength,
  }
  return assets
}

function patchWindowsPythonPth(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
  const next = lines.map((line) => {
    const trimmed = line.trim()
    return trimmed === '#import site' || trimmed === '# import site' ? 'import site' : line
  })
  if (!next.some((line) => line.trim() === 'import site')) {
    next.push('import site')
  }
  for (const path of [
    '.',
    'Lib',
    'Lib\\site-packages',
    'DLLs',
  ]) {
    if (!next.some((line) => line.trim() === path)) next.push(path)
  }
  return `${next.filter((line, index) => line.length > 0 || index < next.length - 1).join('\n')}\n`
}

function linuxWheelPlatformArgs(platform: string): string[] {
  const tags =
    platform === 'linux-arm64'
      ? [
          'manylinux_2_28_aarch64',
          'manylinux_2_17_aarch64',
          'manylinux2014_aarch64',
          'linux_aarch64',
        ]
      : [
          'manylinux_2_28_x86_64',
          'manylinux_2_17_x86_64',
          'manylinux2014_x86_64',
          'linux_x86_64',
        ]
  return tags.flatMap((tag) => [
    '--platform',
    tag,
  ])
}

async function listRelativeFiles(root: string, basePath: string): Promise<string[]> {
  const base = join(root, basePath)
  if (!(await exists(base))) return []
  const written: string[] = []
  await collectRelativeFiles(base, basePath, written)
  return written
}

async function collectRelativeFiles(path: string, relativePath: string, output: string[]): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries) {
    const childRelativePath = `${relativePath}/${entry.name}`
    const childPath = join(path, entry.name)
    if (entry.isDirectory()) {
      await collectRelativeFiles(childPath, childRelativePath, output)
    } else if (entry.isFile()) {
      output.push(childRelativePath)
    }
  }
}

export async function updateOcrModels(
  root: string,
  options: {
    manifestResolver: AssetManifestResolver
    downloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
    signal?: AbortSignal
  },
): Promise<{ written: string[]; files: Array<{ path: string; content: string | Buffer }> } | undefined> {
  throwIfAborted(options.signal)
  const manifest = await options.manifestResolver()
  throwIfAborted(options.signal)
  const basePath = 'resource/base/model/ocr'
  const allowedPaths = [
    'det.onnx',
    'rec.onnx',
    'keys.txt',
    'README.md',
  ]
  const assets = manifest
    ? await downloadManifestAssets(
        manifest,
        options.downloader
          ? {
              downloader: options.downloader,
              allowedPaths,
              ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            }
          : {
              allowedPaths,
              ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            },
      )
    : await downloadDefaultOcrZip(createDefaultOcrZipDownloadOptions(options))
  throwIfAborted(options.signal)
  for (const asset of assets) await trackProjectPathForBackup(root, `${basePath}/${asset.path}`)
  await trackProjectPathForBackup(root, `${basePath}/manifest.json`)
  const { written, manifestContent } = await writeDownloadedAssets(root, basePath, assets)
  return {
    written,
    files: [
      ...assets.map((asset) => ({
        path: join(basePath, asset.path),
        content: asset.content,
      })),
      {
        path: join(basePath, 'manifest.json'),
        content: manifestContent,
      },
    ],
  }
}

export async function updateProjectAssets(
  root: string,
  options: {
    request: ProductAssetManifestRequest
    allowedPathPrefixes: string[]
    manifestResolver: ProductAssetManifestResolver
    downloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
    signal?: AbortSignal
  },
): Promise<{ written: string[] } | undefined> {
  throwIfAborted(options.signal)
  const manifest = await options.manifestResolver(options.request)
  throwIfAborted(options.signal)
  if (!manifest) return undefined
  const assets = await downloadProjectManifestAssets(
    manifest,
    options.downloader
      ? {
          downloader: options.downloader,
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        }
      : {
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
  )
  throwIfAborted(options.signal)
  const reserved = assets.find((asset) => asset.path.startsWith(PROJECT_ASSET_INSTALLATIONS_DIR))
  if (reserved) {
    throw new Error(`Project asset path is reserved for installation state: ${reserved.path}`)
  }
  const installationPath = projectAssetInstallationPath(options.request.product, manifest.platform)
  const previousPaths = await readProjectAssetInstallation(root, installationPath, options.allowedPathPrefixes)
  const nextPaths = new Set(assets.map((asset) => asset.path))
  for (const previousPath of previousPaths) {
    if (nextPaths.has(previousPath)) continue
    await trackProjectPathForBackup(root, previousPath)
    await rm(join(root, previousPath), { recursive: true, force: true })
  }
  for (const asset of assets) await trackProjectPathForBackup(root, asset.path)
  await trackProjectPathForBackup(root, installationPath)
  const written = await writeDownloadedProjectAssets(root, assets)
  await writeFileAtomic(
    join(root, installationPath),
    stableJson({
      schemaVersion: 1,
      product: options.request.product,
      platform: manifest.platform ?? null,
      paths: assets.map((asset) => asset.path).sort(),
    }),
  )
  return {
    written: [
      ...written,
      installationPath,
    ],
  }
}

function projectAssetInstallationPath(product: string, platform: string | undefined): string {
  const productKey = product.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'runtime'
  const platformKey = platform?.toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'default'
  return `${PROJECT_ASSET_INSTALLATIONS_DIR}${productKey}-${platformKey}.json`
}

async function readProjectAssetInstallation(
  root: string,
  installationPath: string,
  allowedPathPrefixes: string[],
): Promise<string[]> {
  const path = join(root, installationPath)
  if (!(await exists(path))) return []
  let value: unknown
  try {
    value = JSON.parse(await readText(path)) as unknown
  } catch (error) {
    throw new Error(`Invalid project asset installation manifest ${installationPath}: ${errorMessage(error)}`)
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.paths)) {
    throw new Error(`Invalid project asset installation manifest ${installationPath}.`)
  }
  const paths: string[] = []
  for (const candidate of value.paths) {
    if (typeof candidate !== 'string' || !allowedPathPrefixes.some((prefix) => candidate.startsWith(prefix))) {
      throw new Error(`Invalid managed asset path in ${installationPath}: ${String(candidate)}`)
    }
    if (candidate.startsWith(PROJECT_ASSET_INSTALLATIONS_DIR)) {
      throw new Error(`Managed asset path is reserved for installation state in ${installationPath}: ${candidate}`)
    }
    assertSafeRelativePath(candidate, `managed asset path in ${installationPath}`)
    if (
      paths.some((existing) => {
        const existingKey = existing.toLowerCase()
        const candidateKey = candidate.toLowerCase()
        return (
          existingKey === candidateKey ||
          existingKey.startsWith(`${candidateKey}/`) ||
          candidateKey.startsWith(`${existingKey}/`)
        )
      })
    ) {
      throw new Error(`Overlapping managed asset paths in ${installationPath}: ${candidate}`)
    }
    paths.push(candidate)
  }
  return paths
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createProjectAssetUpdateOptions(
  request: ProductAssetManifestRequest,
  environment: {
    productManifestResolver?: ProductAssetManifestResolver
    assetDownloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
    signal?: AbortSignal
  },
): {
  request: ProductAssetManifestRequest
  allowedPathPrefixes: string[]
  manifestResolver: ProductAssetManifestResolver
  downloader?: AssetDownloader
  onDownloadProgress?: DownloadProgressReporter
  signal?: AbortSignal
} {
  const options: {
    request: ProductAssetManifestRequest
    allowedPathPrefixes: string[]
    manifestResolver: ProductAssetManifestResolver
    downloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
    signal?: AbortSignal
  } = {
    request,
    allowedPathPrefixes: RUNTIME_ASSET_PATH_PREFIXES,
    manifestResolver:
      environment.productManifestResolver ??
      ((manifestRequest) =>
        resolveProductAssetManifest(manifestRequest, environment.signal ? { signal: environment.signal } : {})),
  }
  if (environment.assetDownloader) options.downloader = environment.assetDownloader
  if (environment.onDownloadProgress) options.onDownloadProgress = environment.onDownloadProgress
  if (environment.signal) options.signal = environment.signal
  return options
}

function createOcrUpdateOptions(environment: {
  ocrManifestResolver?: AssetManifestResolver
  assetDownloader?: AssetDownloader
  onDownloadProgress?: DownloadProgressReporter
  signal?: AbortSignal
}): {
  manifestResolver: AssetManifestResolver
  downloader?: AssetDownloader
  onDownloadProgress?: DownloadProgressReporter
  signal?: AbortSignal
} {
  const options: {
    manifestResolver: AssetManifestResolver
    downloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
    signal?: AbortSignal
  } = {
    manifestResolver:
      environment.ocrManifestResolver ??
      (() => resolveOcrManifestFromEnvironment(environment.signal ? { signal: environment.signal } : {})),
  }
  if (environment.assetDownloader) options.downloader = environment.assetDownloader
  if (environment.onDownloadProgress) options.onDownloadProgress = environment.onDownloadProgress
  if (environment.signal) options.signal = environment.signal
  return options
}

function createDefaultOcrZipDownloadOptions(options: {
  downloader?: AssetDownloader
  onDownloadProgress?: DownloadProgressReporter
  signal?: AbortSignal
}): { downloader?: AssetDownloader; onProgress?: DownloadProgressReporter; signal?: AbortSignal } {
  const downloadOptions: { downloader?: AssetDownloader; onProgress?: DownloadProgressReporter; signal?: AbortSignal } =
    {}
  if (options.downloader) downloadOptions.downloader = options.downloader
  if (options.onDownloadProgress) downloadOptions.onProgress = options.onDownloadProgress
  if (options.signal) downloadOptions.signal = options.signal
  return downloadOptions
}

export type OcrSourcePreference = 'submodule' | 'download'

export function resolveOcrSourceFromEnvironment(): OcrSourcePreference | undefined {
  const raw = process.env.CREATE_MAA_PROJECT_OCR_SOURCE?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw === 'submodule' || raw === 'download') return raw
  throw new Error(`CREATE_MAA_PROJECT_OCR_SOURCE must be "submodule" or "download": ${raw}`)
}

export function defaultOcrSubmoduleConfig(): OcrConfig {
  return {
    source: 'submodule',
    submodulePath: `${DEFAULT_OCR_SUBMODULE_PATH}/${DEFAULT_OCR_SUBMODULE_ASSETS_DIR}`,
    files: Object.fromEntries(DEFAULT_OCR_FILES.map((name) => [name, `${DEFAULT_OCR_MODEL_DIR}/${name}`])),
  }
}

export type OcrSubmoduleGitRunner = (root: string, args: string[]) => Promise<void>

const OCR_SUBMODULE_RECOVERY_HINT = [
  'The OCR model submodule could not be fetched. Recover with one of:',
  '1. switch to the download CDN (hosts ppocr_v6 tiny/small/medium only): set "source": "download" under "ocr" in maa-project.json, then run `create-maa-project --update ocr-models`;',
  '2. route GitHub through a mirror: git config --global url."https://gh-proxy.com/https://github.com/MaaXYZ/MaaCommonAssets.git".insteadOf "https://github.com/MaaXYZ/MaaCommonAssets.git", then retry;',
  '3. serve a local OCR zip: set CREATE_MAA_PROJECT_OCR_ZIP_PATH together with the download source above.',
].join('\n')

class OcrSubmoduleRecoveryError extends Error {}

function withOcrSubmoduleRecoveryHint(error: unknown): OcrSubmoduleRecoveryError {
  const message = error instanceof Error ? error.message : String(error)
  return new OcrSubmoduleRecoveryError(`${message}\n${OCR_SUBMODULE_RECOVERY_HINT}`)
}

const OCR_GITIGNORE_COMMENT = '# OCR models are copied from the MaaCommonAssets submodule and must not be committed.'
const OCR_GITIGNORE_LINE = 'resource/base/model/ocr/'

export async function syncOcrGitignoreForSource(root: string, source: 'submodule' | 'download'): Promise<boolean> {
  const gitignorePath = join(root, '.gitignore')
  if (!(await exists(gitignorePath))) return false
  const content = await readText(gitignorePath)
  const lines = content.split(/\r?\n/u)
  const hasLine = lines.some((line) => line.trim() === OCR_GITIGNORE_LINE)
  if (source === 'submodule') {
    if (hasLine) return false
    await trackProjectPathForBackup(root, '.gitignore')
    const prefix = content.length === 0 || content.endsWith('\n') ? content : `${content}\n`
    await writeText(gitignorePath, `${prefix}${OCR_GITIGNORE_COMMENT}\n${OCR_GITIGNORE_LINE}\n`)
    return true
  }
  if (!hasLine) return false
  await trackProjectPathForBackup(root, '.gitignore')
  const filtered: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    if (line.trim() === OCR_GITIGNORE_LINE) continue
    const next = lines[index + 1]
    if (line.trim() === OCR_GITIGNORE_COMMENT && next?.trim() === OCR_GITIGNORE_LINE) continue
    filtered.push(line)
  }
  await writeText(gitignorePath, filtered.join('\n'))
  return true
}

export async function provisionOcrFromSubmodule(
  root: string,
  options: {
    gitRunner: OcrSubmoduleGitRunner
    url?: string
    signal?: AbortSignal
  },
): Promise<string[]> {
  throwIfAborted(options.signal)
  try {
    await options.gitRunner(root, [
      'clone',
      '--depth',
      '1',
      options.url ?? DEFAULT_OCR_SUBMODULE_URL,
      DEFAULT_OCR_SUBMODULE_PATH,
    ])
  } catch (error) {
    throw withOcrSubmoduleRecoveryHint(error)
  }
  const clonePath = join(root, DEFAULT_OCR_SUBMODULE_PATH)
  try {
    const sourceRoot = await realpath(clonePath)
    const written: string[] = []
    await trackProjectPathForBackup(root, 'resource/base/model/ocr')
    const destination = resolve(root, 'resource/base/model/ocr')
    await mkdir(destination, { recursive: true })
    for (const name of DEFAULT_OCR_FILES) {
      throwIfAborted(options.signal)
      const source = join(sourceRoot, DEFAULT_OCR_SUBMODULE_ASSETS_DIR, DEFAULT_OCR_MODEL_DIR, name)
      if (!(await exists(source))) {
        throw new Error(`The MaaCommonAssets checkout is missing OCR model file ${DEFAULT_OCR_MODEL_DIR}/${name}.`)
      }
      await copyFileAtomic(source, resolve(destination, name))
      written.push(`resource/base/model/ocr/${name}`)
    }
    return written
  } catch (error) {
    await rm(clonePath, { force: true, recursive: true }).catch(() => {})
    throw error
  }
}

type GitmodulesEntry = {
  name: string
  path: string
  url: string
}

async function readOcrSubmodulesEntry(root: string, submodulePath: string): Promise<GitmodulesEntry | undefined> {
  const gitmodulesPath = join(root, '.gitmodules')
  if (!(await exists(gitmodulesPath))) return undefined
  const content = await readText(gitmodulesPath)
  const entries: GitmodulesEntry[] = []
  let name: string | undefined
  let path: string | undefined
  let url: string | undefined
  const pushCurrent = (
    currentName: string | undefined,
    currentPath: string | undefined,
    currentUrl: string | undefined,
  ): void => {
    if (currentName && currentPath && currentUrl) {
      entries.push({
        name: currentName,
        path: currentPath,
        url: currentUrl,
      })
    }
  }
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    const section = /^\[submodule\s+"([^"]+)"\]$/u.exec(line)
    if (section) {
      pushCurrent(name, path, url)
      name = section[1]
      path = undefined
      url = undefined
      continue
    }
    if (!name) continue
    const property = /^(path|url)\s*=\s*(.+)$/u.exec(line)
    if (property) {
      if (property[1] === 'path') path = property[2]?.trim()
      else url = property[2]?.trim()
    }
  }
  pushCurrent(name, path, url)
  const normalized = submodulePath.replace(/\\/gu, '/')
  return entries.find((entry) => normalized === entry.path || normalized.startsWith(`${entry.path}/`))
}

export async function ensureOcrSubmoduleReady(
  root: string,
  ocr: OcrConfig,
  options: {
    commandRunner: UpdateCommandRunner
    onProgress?: ProgressReporter
    signal?: AbortSignal
  },
): Promise<void> {
  throwIfAborted(options.signal)
  const subPath = ocr.submodulePath
  if (!subPath) throw new Error('ocr.submodulePath is required when ocr.source is "submodule"')
  const entry = await readOcrSubmodulesEntry(root, subPath)
  if (!entry) {
    // Not a registered Git submodule (e.g. a plain vendored directory); the copy
    // step below validates the path itself.
    if (await exists(join(root, subPath))) return
    throw withOcrSubmoduleRecoveryHint(
      new Error(
        `ocr.submodulePath "${subPath}" does not exist and has no matching .gitmodules entry. Register the submodule first: git submodule add ${DEFAULT_OCR_SUBMODULE_URL} ${DEFAULT_OCR_SUBMODULE_PATH}`,
      ),
    )
  }
  const repoPath = join(root, entry.path)
  if (await exists(join(repoPath, '.git'))) return
  options.onProgress?.(`Initializing the ${entry.path} submodule...`)
  try {
    if (await exists(join(root, '.git'))) {
      try {
        await options.commandRunner(root, 'git', [
          'submodule',
          'update',
          '--init',
          '--depth',
          '1',
          '--',
          entry.path,
        ])
        return
      } catch {
        // The gitlink may not be staged yet (initial commit still pending after a
        // failed provisioning); a plain clone registers the same content.
      }
      try {
        await options.commandRunner(root, 'git', [
          'clone',
          '--depth',
          '1',
          entry.url,
          entry.path,
        ])
        return
      } catch (cloneError) {
        throw withOcrSubmoduleRecoveryHint(cloneError)
      }
    }
    await options.commandRunner(root, 'git', [
      'clone',
      '--depth',
      '1',
      entry.url,
      entry.path,
    ])
  } catch (error) {
    if (error instanceof OcrSubmoduleRecoveryError) throw error
    throw withOcrSubmoduleRecoveryHint(error)
  }
}

function schemaFilesForConfig(config: MaaProjectConfig): ManagedFileInput[] {
  return baseProjectFiles({
    slug: config.project.slug,
    displayName: config.project.displayName,
    version: config.project.version,
    controllers: projectControllerKinds(config),
    license: config.license.spdx,
    includeDevTools: hasDevTools(config),
    includeGithub: hasGithubAutomation(config),
    includeAgent: config.python !== undefined,
    includeGitCliff: isAddonEnabled(config, 'gitCliff'),
    includeAutoFormat: isAddonEnabled(config, 'autoFormat'),
    includeOptimizeImages: isAddonEnabled(config, 'optimizeImages'),
    includeSchemaSync: isAddonEnabled(config, 'schemaSync'),
    pythonDevCommand: config.python?.devCommand,
    resources: enabledResourcePacks(config),
    ocrSubmodule: config.ocr?.source === 'submodule',
  }).filter((file) => file.path.startsWith('tools/schema/'))
}

function assertSafeRelativePath(
  value: string,
  label: string,
  options: { allowNested: boolean } = { allowNested: true },
): void {
  const segments = value.split('/')
  if (
    value.trim() !== value ||
    value === '' ||
    value.includes('\\') ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    (!options.allowNested && segments.length !== 1)
  ) {
    const expectation = options.allowNested ? 'a project-relative path' : 'a single file name'
    throw new Error(`${label} must be ${expectation} without absolute, empty, dot, or backslash segments: ${value}`)
  }
}

async function resolveContainedExistingPath(base: string, value: string, label: string): Promise<string> {
  assertSafeRelativePath(value, label)
  const resolvedBase = await realpath(base)
  const candidate = await realpath(resolve(resolvedBase, value))
  assertPathWithin(resolvedBase, candidate, label)
  return candidate
}

function assertPathWithin(base: string, candidate: string, label: string): void {
  const relativePath = relative(base, candidate)
  if (
    relativePath === '' ||
    (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
  ) {
    return
  }
  throw new Error(`${label} must stay within ${base}: ${candidate}`)
}

async function assertTreeContainsNoSymlinks(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink() || (await lstat(child)).isSymbolicLink()) {
      throw new Error(`OCR submodule directory copy does not allow symbolic links: ${child}`)
    }
    if (entry.isDirectory()) await assertTreeContainsNoSymlinks(child)
  }
}
