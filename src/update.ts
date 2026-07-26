import {
  mergePending,
  readProjectConfig,
  trackProjectPathForBackup,
  withProjectWriteLock,
  writeGeneratedFiles,
  writeProjectState,
} from './project.js'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
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
import type { CliOptions, MaaProjectConfig, ManagedFileInput, PendingItem, ScaffoldResult } from './types.js'
import { copyFileAtomic, exists, readText, sha256, writeFileAtomic } from './utils.js'
import { projectControllerKinds } from './controllers.js'
import { enabledResourcePacks, hasDevTools, hasGithubAutomation, isAddonEnabled } from './features.js'
import { isUpdateTarget, type UpdateTarget } from './update-targets.js'

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

export async function recordUpdateRequests(
  options: CliOptions,
  environment: {
    commandRunner?: UpdateCommandRunner
    ocrManifestResolver?: AssetManifestResolver
    productManifestResolver?: ProductAssetManifestResolver
    assetDownloader?: AssetDownloader
    onProgress?: ProgressReporter
    onDownloadProgress?: DownloadProgressReporter
    root?: string
  } = {},
): Promise<ScaffoldResult> {
  const root = environment.root ?? process.cwd()
  const config = await readProjectConfig(root)
  const commandRunner = environment.commandRunner ?? runCommand
  const targets = [
    ...new Set(options.update.map(validateUpdateTarget)),
  ]

  return withProjectWriteLock(
    root,
    process.argv.join(' '),
    async (operation) => {
      const written = new Set<string>()
      const skipped: string[] = []
      let pendingToAdd: PendingItem[] = []

      for (const target of targets) {
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
            continue
          }
          environment.onProgress?.('Downloading OCR models...')
          const result = await updateOcrModels(root, createOcrUpdateOptions(environment))
          if (!result) {
            pendingToAdd.push(toPendingUpdate(target))
            continue
          }
          for (const path of result.written) written.add(path)
          environment.onProgress?.('OCR models downloaded.')
          continue
        }
        pendingToAdd.push(toPendingUpdate(target))
      }

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
    'node_modules/.pnpm',
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
  },
): Promise<{ written: string[] } | undefined> {
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
  if (!manifest) return undefined
  const runtimeRoot = `.create-maa-project/runtime/python/${platform}`
  await trackProjectPathForBackup(root, runtimeRoot)
  await rm(join(root, runtimeRoot), {
    recursive: true,
    force: true,
  })
  const assets = await downloadProjectManifestAssets(
    manifest,
    options.downloader
      ? {
          downloader: options.downloader,
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {}),
        }
      : {
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {}),
        },
  )
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
  },
): Promise<{ written: string[] }> {
  const runtimeRoot = `.create-maa-project/runtime/python/${platform}`
  await trackProjectPathForBackup(root, runtimeRoot)
  await rm(join(root, runtimeRoot), {
    recursive: true,
    force: true,
  })
  const arch = platform.endsWith('-arm64') ? 'arm64' : 'amd64'
  const filename = `python-${PYTHON_EMBED_VERSION}-embed-${arch}.zip`
  const url = `https://www.python.org/ftp/python/${PYTHON_EMBED_VERSION}/${filename}`
  const archive = await downloadRuntimeArchive(url, options.downloader, options.onDownloadProgress)
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
  await trackProjectPathForBackup(root, depsPath)
  await rm(join(root, depsPath), {
    recursive: true,
    force: true,
  })
  await mkdir(join(root, depsPath), { recursive: true })
  await commandRunner(root, 'python3', [
    '-m',
    'pip',
    'download',
    '--requirement',
    'requirements.txt',
    '--dest',
    depsPath,
    '--only-binary=:all:',
    ...linuxWheelPlatformArgs(platform),
  ])
  return {
    written: await listRelativeFiles(root, depsPath),
  }
}

async function downloadRuntimeArchive(
  url: string,
  downloader?: AssetDownloader,
  onDownloadProgress?: DownloadProgressReporter,
): Promise<Buffer> {
  const options = onDownloadProgress
    ? {
        onProgress: onDownloadProgress,
      }
    : undefined
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
  },
): Promise<{ written: string[]; files: Array<{ path: string; content: string | Buffer }> } | undefined> {
  const manifest = await options.manifestResolver()
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
            }
          : {
              allowedPaths,
              ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {}),
            },
      )
    : await downloadDefaultOcrZip(createDefaultOcrZipDownloadOptions(options))
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
  },
): Promise<{ written: string[] } | undefined> {
  const manifest = await options.manifestResolver(options.request)
  if (!manifest) return undefined
  const assets = await downloadProjectManifestAssets(
    manifest,
    options.downloader
      ? {
          downloader: options.downloader,
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {}),
        }
      : {
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {}),
        },
  )
  for (const asset of assets) await trackProjectPathForBackup(root, asset.path)
  return {
    written: await writeDownloadedProjectAssets(root, assets),
  }
}

function createProjectAssetUpdateOptions(
  request: ProductAssetManifestRequest,
  environment: {
    productManifestResolver?: ProductAssetManifestResolver
    assetDownloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
  },
): {
  request: ProductAssetManifestRequest
  allowedPathPrefixes: string[]
  manifestResolver: ProductAssetManifestResolver
  downloader?: AssetDownloader
  onDownloadProgress?: DownloadProgressReporter
} {
  const options: {
    request: ProductAssetManifestRequest
    allowedPathPrefixes: string[]
    manifestResolver: ProductAssetManifestResolver
    downloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
  } = {
    request,
    allowedPathPrefixes: RUNTIME_ASSET_PATH_PREFIXES,
    manifestResolver: environment.productManifestResolver ?? resolveProductAssetManifest,
  }
  if (environment.assetDownloader) options.downloader = environment.assetDownloader
  if (environment.onDownloadProgress) options.onDownloadProgress = environment.onDownloadProgress
  return options
}

function createOcrUpdateOptions(environment: {
  ocrManifestResolver?: AssetManifestResolver
  assetDownloader?: AssetDownloader
  onDownloadProgress?: DownloadProgressReporter
}): {
  manifestResolver: AssetManifestResolver
  downloader?: AssetDownloader
  onDownloadProgress?: DownloadProgressReporter
} {
  const options: {
    manifestResolver: AssetManifestResolver
    downloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
  } = {
    manifestResolver: environment.ocrManifestResolver ?? resolveOcrManifestFromEnvironment,
  }
  if (environment.assetDownloader) options.downloader = environment.assetDownloader
  if (environment.onDownloadProgress) options.onDownloadProgress = environment.onDownloadProgress
  return options
}

function createDefaultOcrZipDownloadOptions(options: {
  downloader?: AssetDownloader
  onDownloadProgress?: DownloadProgressReporter
}): { downloader?: AssetDownloader; onProgress?: DownloadProgressReporter } {
  const downloadOptions: { downloader?: AssetDownloader; onProgress?: DownloadProgressReporter } = {}
  if (options.downloader) downloadOptions.downloader = options.downloader
  if (options.onDownloadProgress) downloadOptions.onProgress = options.onDownloadProgress
  return downloadOptions
}

async function runCommand(root: string, command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    })
    child.on('error', (error) => {
      reject(
        new Error(
          `Failed to run ${[
            command,
            ...args,
          ].join(' ')}. ${error.message}`,
        ),
      )
    })
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      reject(
        new Error(
          `Command failed: ${[
            command,
            ...args,
          ].join(' ')} (${suffix})`,
        ),
      )
    })
  })
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
