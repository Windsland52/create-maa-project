import {
  createUnifiedDiff,
  managedFileHash,
  mergePending,
  prepareManagedFileContent,
  readProjectConfig,
  readProjectLock,
  refreshManagedFileContent,
  refreshManagedFileState,
  withProjectWriteLock,
  writeGeneratedFiles,
  writeProjectState
} from './project.js'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, readdir, rm } from 'node:fs/promises'
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
  type ProductAssetManifestResolver
} from './assets.js'
import { baseProjectFiles } from './templates.js'
import type {
  CliOptions,
  MaaProjectConfig,
  ManagedFileInput,
  PendingItem,
  ScaffoldResult
} from './types.js'
import { exists, readText, sha256 } from './utils.js'
import { projectControllerKinds } from './controllers.js'
import { hasDevTools, hasGithubAutomation } from './features.js'

const CLI_VERSION = '0.1.0'

const UPDATE_PENDING: Record<string, PendingItem> = {
  schema: {
    kind: 'schema',
    reason:
      'Schema baseline update is pending because schema downloads are not implemented locally yet.',
    command: 'create-maa-project --update schema'
  },
  maafw: {
    kind: 'maafw',
    reason: 'MaaFramework asset resolution is pending.',
    command: 'create-maa-project --update maafw'
  },
  'runtime:mfa': {
    kind: 'runtime',
    reason: 'MFAAvalonia runtime asset resolution is pending.',
    command: 'create-maa-project --update runtime:mfa'
  },
  'ocr-models': {
    kind: 'ocr-model',
    reason: 'OCR model download is pending.',
    command: 'create-maa-project --update ocr-models'
  },
  'node-deps': {
    kind: 'node-deps',
    reason: 'Node dependencies need to be installed or refreshed locally.',
    command: 'create-maa-project --update node-deps'
  },
  'python-deps': {
    kind: 'python-deps',
    reason: 'Python dependencies need to be synchronized locally.',
    command: 'create-maa-project --update python-deps'
  },
  'python-runtime': {
    kind: 'python-runtime',
    reason: 'Python release runtime and Agent release dependencies are pending.',
    command: 'create-maa-project --update python-runtime'
  },
  template: {
    kind: 'template',
    reason: 'Template update is pending.',
    command: 'create-maa-project --update template'
  }
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
  } = {}
): Promise<ScaffoldResult> {
  const root = process.cwd()
  const config = await readProjectConfig(root)
  const lock = await readProjectLock(root)
  const commandRunner = environment.commandRunner ?? runCommand
  const targets = options.update.map(validateUpdateTarget)

  return withProjectWriteLock(
    root,
    process.argv.join(' '),
    async () => {
      const written = new Set<string>()
      const skipped: string[] = []
      let pendingToAdd: PendingItem[] = []

      if (targets.includes('template')) {
        const plan = await planTemplateUpdate(root, config, lock, options.force)
        const result = await writeGeneratedFiles(root, plan.files, {
          force: true,
          backup: true
        })
        Object.assign(lock.managedFiles, result.lockEntries)
        for (const path of result.written) written.add(path)
        for (const path of await refreshManagedFileContent(root, lock, plan.refreshed, {
          template: true
        })) {
          written.add(path)
        }
        skipped.push(...plan.skipped, ...result.skipped)
        lock.pending = removePending(lock.pending, 'template')
      }

      for (const target of targets) {
        if (target === 'template') continue
        if (target === 'schema') {
          const plan = await planSchemaUpdate(root, config, lock, options.force)
          const result = await writeGeneratedFiles(root, plan.files, {
            force: true,
            backup: true
          })
          Object.assign(lock.managedFiles, result.lockEntries)
          for (const path of result.written) written.add(path)
          for (const path of await refreshManagedFileContent(root, lock, plan.refreshed, {
            template: true
          })) {
            written.add(path)
          }
          skipped.push(...plan.skipped, ...result.skipped)
          lock.pending = removePending(lock.pending, 'schema')
          continue
        }
        if (target === 'node-deps') {
          await updateNodeDeps(root, commandRunner)
          lock.pending = removePending(lock.pending, 'node-deps')
          if (await exists(join(root, 'pnpm-lock.yaml'))) written.add('pnpm-lock.yaml')
          continue
        }
        if (target === 'python-deps') {
          await updatePythonDeps(root, commandRunner)
          lock.pending = removePending(lock.pending, 'python-deps')
          for (const path of await refreshManagedFileState(root, lock, [
            'uv.lock',
            'requirements.txt'
          ])) {
            written.add(path)
          }
          continue
        }
        if (target === 'python-runtime') {
          environment.onProgress?.('Synchronizing Python release runtime assets...')
          const result = await updatePythonRuntime(root, {
            ...createProjectAssetUpdateOptions(
              {
                product: 'Python',
                channel: 'latest'
              },
              environment
            ),
            commandRunner
          })
          if (!result) {
            pendingToAdd.push(remoteAssetPending(target))
            continue
          }
          for (const path of result.written) written.add(path)
          lock.pending = removePending(lock.pending, 'python-runtime')
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
                channel: config.maafw.channel
              },
              environment
            )
          )
          if (!result) {
            pendingToAdd.push(remoteAssetPending(target))
            continue
          }
          for (const path of result.written) written.add(path)
          lock.pending = removePending(lock.pending, 'maafw')
          environment.onProgress?.('MaaFramework assets downloaded.')
          continue
        }
        if (target === 'runtime:mfa') {
          environment.onProgress?.('Resolving MFAAvalonia runtime assets...')
          const result = await updateProjectAssets(
            root,
            createProjectAssetUpdateOptions(
              {
                product: 'MFAAvalonia',
                channel: config.runtime.mfa.channel
              },
              environment
            )
          )
          if (!result) {
            pendingToAdd.push(remoteAssetPending(target))
            continue
          }
          for (const path of result.written) written.add(path)
          lock.pending = removePending(lock.pending, 'runtime')
          environment.onProgress?.('MFAAvalonia runtime assets downloaded.')
          continue
        }
        if (target === 'ocr-models') {
          environment.onProgress?.('Downloading OCR models...')
          const result = await updateOcrModels(root, createOcrUpdateOptions(environment))
          if (!result) {
            pendingToAdd.push(toPendingUpdate(target))
            continue
          }
          for (const path of result.written) written.add(path)
          for (const path of await refreshManagedFileContent(root, lock, result.files)) {
            written.add(path)
          }
          lock.pending = removePending(lock.pending, 'ocr-model')
          environment.onProgress?.('OCR models downloaded.')
          continue
        }
        pendingToAdd.push(toPendingUpdate(target))
      }

      lock.pending = mergePending(lock.pending, pendingToAdd)
      lock.template.lastUpdatedBy = 'create-maa-project'
      lock.template.templateVersion = CLI_VERSION
      await writeProjectState(root, config, lock)
      written.add('maa-project.json')
      written.add('maa-project.lock.json')
      return {
        root,
        config,
        lock,
        written: [
          ...written
        ],
        skipped,
        pending: lock.pending
      }
    },
    { clearStale: options.clearStaleLock }
  )
}

export async function previewTemplateUpdate(options: CliOptions): Promise<string[]> {
  const target = options.update[0]
  if (options.update.length !== 1 || (target !== 'template' && target !== 'schema')) {
    throw new Error(
      '--update <target> --diff is only supported for --update template or --update schema in this version.'
    )
  }
  const root = process.cwd()
  const config = await readProjectConfig(root)
  const lock = await readProjectLock(root)
  const plan =
    target === 'schema'
      ? await planSchemaUpdate(root, config, lock, options.force)
      : await planTemplateUpdate(root, config, lock, options.force)
  const lines: string[] = []
  for (const item of plan.preview) {
    if (item.kind === 'diff') {
      lines.push(...createUnifiedDiff(item.path, item.current, item.next))
    } else if (item.kind === 'add') {
      lines.push(`[ADD] ${item.path}`)
    } else if (item.kind === 'refresh') {
      lines.push(`[REFRESH] ${item.path}`)
    }
  }
  for (const skipped of plan.skipped) {
    lines.push(`[SKIP] ${skipped}`)
  }
  return lines.length > 0 ? lines : [
        'No template updates.'
      ]
}

function validateUpdateTarget(target: string): string {
  if (target === 'all') {
    throw new Error('--update all is not supported. Update one target at a time.')
  }
  if (!UPDATE_PENDING[target]) {
    throw new Error(`Unsupported update target: ${target}`)
  }
  return target
}

const RUNTIME_ASSET_PATH_PREFIXES = [
  '.create-maa-project/runtime/',
  'runtimes/',
  'libs/',
  'plugins/'
]

function embeddedPythonExecutable(platform: string): string {
  return platform.startsWith('win-')
    ? `.create-maa-project/runtime/python/${platform}/python.exe`
    : `.create-maa-project/runtime/python/${platform}/bin/python3`
}

function toPendingUpdate(target: string): PendingItem {
  const pending = UPDATE_PENDING[target]
  if (!pending) {
    throw new Error(`Unsupported update target: ${target}`)
  }
  return pending
}

function remoteAssetPending(target: string): PendingItem {
  const pending = toPendingUpdate(target)
  return {
    ...pending,
    reason: `${pending.reason} No compatible GitHub release asset or explicit manifest was found.`
  }
}

async function updateNodeDeps(root: string, commandRunner: UpdateCommandRunner): Promise<void> {
  await commandRunner(root, 'pnpm', [
    'install'
  ])
}

async function updatePythonDeps(root: string, commandRunner: UpdateCommandRunner): Promise<void> {
  if (!(await exists(join(root, 'pyproject.toml')))) {
    throw new Error('--update python-deps requires an Agent project with pyproject.toml.')
  }
  await commandRunner(root, 'uv', [
    'lock'
  ])
  await commandRunner(root, 'uv', [
    'export',
    '--format',
    'requirements-txt',
    '--no-hashes',
    '--no-emit-project',
    '--output-file',
    'requirements.txt'
  ])
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
  }
): Promise<{ written: string[] } | undefined> {
  if (!(await exists(join(root, 'pyproject.toml')))) {
    throw new Error('--update python-runtime requires an Agent project with pyproject.toml.')
  }
  if (!(await exists(join(root, 'requirements.txt')))) {
    throw new Error(
      '--update python-runtime requires requirements.txt. Run --update python-deps first.'
    )
  }

  const platform = resolveRuntimePlatform(options.request.platform)
  if (!platform || platform === 'all') {
    throw new Error(
      '--update python-runtime requires exactly one runtime platform because Agent dependencies are installed into a platform-specific Python runtime. Set CREATE_MAA_PROJECT_RUNTIME_PLATFORM=<os>-<arch>.'
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
  await rm(join(root, '.create-maa-project/runtime/python', platform), {
    recursive: true,
    force: true
  })
  const assets = await downloadProjectManifestAssets(
    manifest,
    options.downloader
      ? {
          downloader: options.downloader,
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {})
        }
      : {
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {})
        }
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
    'requirements.txt'
  ])
  return {
    written: [
      ...written,
      python
    ]
  }
}

async function updateWindowsEmbeddedPythonRuntime(
  root: string,
  platform: string,
  options: {
    commandRunner: UpdateCommandRunner
    downloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
  }
): Promise<{ written: string[] }> {
  await rm(join(root, '.create-maa-project/runtime/python', platform), {
    recursive: true,
    force: true
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
        format: 'zip'
      }
    })
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
    'requirements.txt'
  ])
  return {
    written: [
      ...written,
      python
    ]
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
  await copyFile(join(root, binPath, candidate), join(root, python))
  await chmod(join(root, python), 0o755)
  return python
}

async function findPythonExecutableCandidate(
  root: string,
  binPath: string
): Promise<string | undefined> {
  if (!(await exists(join(root, binPath)))) return undefined
  for (const name of [
    'python3.13',
    'python3.13t',
    'python'
  ]) {
    if (await exists(join(root, binPath, name))) return name
  }
  return (await readdir(join(root, binPath))).find((name) => /^python3(?:\.\d+)?$/.test(name))
}

async function updateLinuxPythonRuntime(
  root: string,
  platform: string,
  commandRunner: UpdateCommandRunner
): Promise<{ written: string[] }> {
  const depsPath = `.create-maa-project/runtime/python-deps/${platform}`
  await rm(join(root, depsPath), {
    recursive: true,
    force: true
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
    ...linuxWheelPlatformArgs(platform)
  ])
  return {
    written: await listRelativeFiles(root, depsPath)
  }
}

async function downloadRuntimeArchive(
  url: string,
  downloader?: AssetDownloader,
  onDownloadProgress?: DownloadProgressReporter
): Promise<Buffer> {
  const options = onDownloadProgress
    ? {
        onProgress: onDownloadProgress
      }
    : undefined
  return downloader ? downloader(url, options) : downloadUrl(url, options)
}

function patchWindowsEmbeddedPythonAssets(
  platform: string,
  assets: ReturnType<typeof extractProjectArchiveAssets>
): ReturnType<typeof extractProjectArchiveAssets> {
  const pthPath = `.create-maa-project/runtime/python/${platform}/`
  const index = assets.findIndex(
    (asset) =>
      asset.path.startsWith(pthPath) &&
      /^python\d*\._pth$/i.test(asset.path.split('/').at(-1) ?? '')
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
    size: nextContent.byteLength
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
    'DLLs'
  ]) {
    if (!next.some((line) => line.trim() === path)) next.push(path)
  }
  return `${next.filter((line, index) => line.length > 0 || index < next.length - 1).join('\n')}\n`
}

function linuxWheelPlatformArgs(platform: string): string[] {
  const tags = platform === 'linux-arm64' ? [
          'manylinux_2_28_aarch64',
          'manylinux_2_17_aarch64',
          'manylinux2014_aarch64',
          'linux_aarch64'
        ] : [
          'manylinux_2_28_x86_64',
          'manylinux_2_17_x86_64',
          'manylinux2014_x86_64',
          'linux_x86_64'
        ]
  return tags.flatMap((tag) => [
    '--platform',
    tag
  ])
}

async function listRelativeFiles(root: string, basePath: string): Promise<string[]> {
  const base = join(root, basePath)
  if (!(await exists(base))) return []
  const written: string[] = []
  await collectRelativeFiles(base, basePath, written)
  return written
}

async function collectRelativeFiles(
  path: string,
  relativePath: string,
  output: string[]
): Promise<void> {
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
  }
): Promise<
  { written: string[]; files: Array<{ path: string; content: string | Buffer }> } | undefined
> {
  const manifest = await options.manifestResolver()
  const basePath = 'resource/base/model/ocr'
  const allowedPaths = [
    'det.onnx',
    'rec.onnx',
    'keys.txt',
    'README.md'
  ]
  const assets = manifest
    ? await downloadManifestAssets(
        manifest,
        options.downloader
          ? {
              downloader: options.downloader,
              allowedPaths,
              ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {})
            }
          : {
              allowedPaths,
              ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {})
            }
      )
    : await downloadDefaultOcrZip(createDefaultOcrZipDownloadOptions(options))
  const { written, manifestContent } = await writeDownloadedAssets(root, basePath, assets)
  return {
    written,
    files: [
      ...assets.map((asset) => ({
        path: join(basePath, asset.path),
        content: asset.content
      })),
      {
        path: join(basePath, 'manifest.json'),
        content: manifestContent
      }
    ]
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
  }
): Promise<{ written: string[] } | undefined> {
  const manifest = await options.manifestResolver(options.request)
  if (!manifest) return undefined
  const assets = await downloadProjectManifestAssets(
    manifest,
    options.downloader
      ? {
          downloader: options.downloader,
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {})
        }
      : {
          allowedPathPrefixes: options.allowedPathPrefixes,
          ...(options.onDownloadProgress ? { onProgress: options.onDownloadProgress } : {})
        }
  )
  return {
    written: await writeDownloadedProjectAssets(root, assets)
  }
}

function createProjectAssetUpdateOptions(
  request: ProductAssetManifestRequest,
  environment: {
    productManifestResolver?: ProductAssetManifestResolver
    assetDownloader?: AssetDownloader
    onDownloadProgress?: DownloadProgressReporter
  }
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
    manifestResolver: environment.productManifestResolver ?? resolveProductAssetManifest
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
    manifestResolver: environment.ocrManifestResolver ?? resolveOcrManifestFromEnvironment
  }
  if (environment.assetDownloader) options.downloader = environment.assetDownloader
  if (environment.onDownloadProgress) options.onDownloadProgress = environment.onDownloadProgress
  return options
}

function createDefaultOcrZipDownloadOptions(options: {
  downloader?: AssetDownloader
  onDownloadProgress?: DownloadProgressReporter
}): { downloader?: AssetDownloader; onProgress?: DownloadProgressReporter } {
  const downloadOptions: { downloader?: AssetDownloader; onProgress?: DownloadProgressReporter } =
    {}
  if (options.downloader) downloadOptions.downloader = options.downloader
  if (options.onDownloadProgress) downloadOptions.onProgress = options.onDownloadProgress
  return downloadOptions
}

function removePending(pending: PendingItem[], kind: string): PendingItem[] {
  return pending.filter((item) => item.kind !== kind)
}

async function runCommand(root: string, command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === 'win32',
      stdio: 'inherit'
    })
    child.on('error', (error) => {
      reject(
        new Error(
          `Failed to run ${[
            command,
            ...args
          ].join(' ')}. ${error.message}`
        )
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
            ...args
          ].join(' ')} (${suffix})`
        )
      )
    })
  })
}

async function planTemplateUpdate(
  root: string,
  config: MaaProjectConfig,
  lock: Awaited<ReturnType<typeof readProjectLock>>,
  force: boolean
): Promise<{
  files: ManagedFileInput[]
  skipped: string[]
  refreshed: Array<{ path: string; content: string | Buffer }>
  preview: Array<
    | { kind: 'diff'; path: string; current: string; next: string }
    | { kind: 'add'; path: string }
    | { kind: 'refresh'; path: string }
  >
}> {
  return planManagedTemplateFiles(root, lock, force, templateFilesForConfig(config))
}

async function planSchemaUpdate(
  root: string,
  config: MaaProjectConfig,
  lock: Awaited<ReturnType<typeof readProjectLock>>,
  force: boolean
): Promise<{
  files: ManagedFileInput[]
  skipped: string[]
  refreshed: Array<{ path: string; content: string | Buffer }>
  preview: Array<
    | { kind: 'diff'; path: string; current: string; next: string }
    | { kind: 'add'; path: string }
    | { kind: 'refresh'; path: string }
  >
}> {
  return planManagedTemplateFiles(
    root,
    lock,
    force,
    templateFilesForConfig(config).filter((file) => file.path.startsWith('tools/schema/'))
  )
}

async function planManagedTemplateFiles(
  root: string,
  lock: Awaited<ReturnType<typeof readProjectLock>>,
  force: boolean,
  templateFiles: ManagedFileInput[]
): Promise<{
  files: ManagedFileInput[]
  skipped: string[]
  refreshed: Array<{ path: string; content: string | Buffer }>
  preview: Array<
    | { kind: 'diff'; path: string; current: string; next: string }
    | { kind: 'add'; path: string }
    | { kind: 'refresh'; path: string }
  >
}> {
  const files: ManagedFileInput[] = []
  const skipped: string[] = []
  const refreshed: Array<{ path: string; content: string | Buffer }> = []
  const preview: Array<
    | { kind: 'diff'; path: string; current: string; next: string }
    | { kind: 'add'; path: string }
    | { kind: 'refresh'; path: string }
  > = []
  for (const file of templateFiles) {
    if (typeof file.content !== 'string') {
      throw new Error(`Template update preview does not support binary files: ${file.path}`)
    }
    const state = lock.managedFiles[file.path]
    const targetPath = join(root, file.path)
    const targetExists = await exists(targetPath)
    const currentContent = targetExists ? await readText(targetPath) : undefined
    const nextContent =
      currentContent === undefined
        ? file.content
        : prepareManagedFileContent(file.path, currentContent, file.content)
    const nextHash = managedFileHash(file.path, nextContent)

    if (!state) {
      if (targetExists && !force) {
        skipped.push(`${file.path}: file exists but is not managed`)
        continue
      }
      files.push({ ...file, content: nextContent })
      preview.push({
        kind: targetExists ? 'diff' : 'add',
        path: file.path,
        current: currentContent ?? '',
        next: nextContent
      })
      continue
    }

    if (state.acceptedAt && !force) {
      skipped.push(`${file.path}: accepted local baseline`)
      continue
    }

    if (currentContent !== undefined) {
      const currentHash = managedFileHash(file.path, currentContent)
      if (currentHash === nextHash) {
        if (currentHash !== state.hash || state.templateHash !== nextHash) {
          refreshed.push({ path: file.path, content: nextContent })
          preview.push({ kind: 'refresh', path: file.path })
        }
        continue
      }
      if (currentHash !== state.hash && !force) {
        skipped.push(`${file.path}: local changes`)
        continue
      }
      files.push({ ...file, content: nextContent })
      preview.push({ kind: 'diff', path: file.path, current: currentContent, next: nextContent })
    } else {
      files.push({ ...file, content: nextContent })
      preview.push({ kind: 'add', path: file.path })
    }
  }
  return { files, skipped, refreshed, preview }
}

function templateFilesForConfig(config: MaaProjectConfig): ManagedFileInput[] {
  return baseProjectFiles({
    slug: config.project.slug,
    displayName: config.project.displayName,
    version: config.project.version,
    controllers: projectControllerKinds(config),
    license: config.license.spdx,
    includeDevTools: hasDevTools(config),
    includeGithub: hasGithubAutomation(config),
    includeAgent: config.python !== undefined,
    includeGitCliff: Boolean(config.addons.gitCliff),
    includeAutoFormat: Boolean(config.addons.autoFormat),
    includeOptimizeImages: Boolean(config.addons.optimizeImages),
    includeSchemaSync: Boolean(config.addons.schemaSync),
    pythonDevCommand: config.python?.devCommand,
    resources: config.resources
  })
    .filter((file) => file.managed && file.path !== 'maa-project.json')
    .filter((file) => file.path !== 'uv.lock' && file.path !== 'requirements.txt')
    .filter((file) => !file.path.startsWith('resource/base/model/ocr/'))
}
