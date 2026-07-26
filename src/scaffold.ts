import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  agentFiles,
  autoFormatFiles,
  baseProjectFiles,
  configFile,
  communityFiles,
  dependabotFile,
  defaultAgentDevCommand,
  devToolFiles,
  emptyPng,
  gitCliffFiles,
  githubFiles,
  interfaceAgent,
  interfaceResourceItems,
  maatoolsConfigFile,
  optimizeImagesFiles,
  projectCustomSchemaFiles,
  releaseWorkflowFile,
  schemaSyncFiles,
} from './templates.js'
import type {
  CliOptions,
  GitInitResult,
  MaaProjectConfig,
  ManagedFileInput,
  PendingItem,
  ScaffoldResult,
} from './types.js'
import { assertValidSlug, exists, normalizeSlug, prettyJson, readText, stableJson, stripV, writeText } from './utils.js'
import { assertValidSemVer } from './semver.js'
import {
  listDirectoryEntries,
  mergePending,
  readProjectConfig,
  restoreTrackedProjectPaths,
  trackProjectPathForBackup,
  withProjectLock,
  withProjectWriteLock,
  writeGeneratedFiles,
  writeProjectState,
} from './project.js'
import { assertSupportedCreateAddons, resolveAddonDependencies } from './addons.js'
import {
  resolveOcrManifestFromEnvironment,
  type AssetDownloader,
  type AssetManifestResolver,
  type DownloadProgressReporter,
} from './assets.js'
import { DEFAULT_CONTROLLER_KINDS, projectControllerKinds } from './controllers.js'
import { hasDevTools, hasGithubAutomation } from './features.js'
import { updateOcrModels } from './update.js'

const execFileAsync = promisify(execFile)

export type GitRunner = (root: string, args: string[]) => Promise<void>
export type GitTreeDetector = (path: string) => Promise<boolean>
export type CommandRunner = (root: string, command: string, args: string[]) => Promise<void>
export type ProgressReporter = (message: string) => void

export async function createProject(
  options: CliOptions,
  environment: {
    gitRunner?: GitRunner
    detectGitTree?: GitTreeDetector
    installNodeDeps?: boolean
    downloadOcrModels?: boolean
    commandRunner?: CommandRunner
    ocrManifestResolver?: AssetManifestResolver
    assetDownloader?: AssetDownloader
    onProgress?: ProgressReporter
    onDownloadProgress?: DownloadProgressReporter
    cwd?: string
  } = {},
): Promise<ScaffoldResult> {
  assertSupportedCreateAddons(options.add)
  const targetRoot = resolve(environment.cwd ?? process.cwd(), options.name ?? '.')
  const detectGitTree = environment.detectGitTree ?? isInsideGitTree
  const targetInsideGitTree = await detectGitTree(targetRoot)
  const defaultName = options.name && options.name !== '.' ? basename(options.name) : basename(targetRoot)
  const slug = options.slug ? normalizeSlug(options.slug) : normalizeSlug(defaultName)
  if (!slug) {
    throw new Error(
      `Project ID cannot be inferred from "${defaultName}". Use --slug with an ASCII kebab-case value, and pass --name for the display name.`,
    )
  }
  assertValidSlug(slug)
  const displayName = requiredNonBlank(
    options.displayName ?? options.label ?? defaultName,
    'Project display name cannot be blank.',
  )
  const version = stripV(options.version ?? '0.1.0')
  assertValidSemVer(version)

  await assertCanCreateTarget(targetRoot, options, detectGitTree)
  await mkdir(targetRoot, { recursive: true })

  const includeAgent = options.template === 'agent' || options.add.includes('agent')
  const resolvedAddons = resolveAddonDependencies(options.add, { includeAgent })
  const includeDevTools = resolvedAddons.includes('dev-tools')
  const includeGithub = resolvedAddons.includes('github')
  const pythonDevCommand = includeAgent ? defaultAgentDevCommand() : undefined
  const config = createConfig({
    slug,
    displayName,
    version,
    includeAgent,
    pythonDevCommand,
    options,
    resolvedAddons,
  })
  const shouldDownloadOcrModels = environment.downloadOcrModels === true && !options.skipDownload
  let pending = defaultPending({
    includeAgent,
    options,
    includeDevTools,
    includeOcrPending: !shouldDownloadOcrModels,
  })
  const files = [
    ...baseProjectFiles({
      slug,
      displayName,
      version,
      controllers: options.controllers ?? DEFAULT_CONTROLLER_KINDS,
      license: options.license ?? 'AGPL-3.0-or-later',
      includeDevTools,
      includeGithub,
      includeAgent,
      includeGitCliff: resolvedAddons.includes('git-cliff'),
      includeAutoFormat: resolvedAddons.includes('auto-format'),
      includeOptimizeImages: resolvedAddons.includes('optimize-images'),
      includeSchemaSync: resolvedAddons.includes('schema-sync'),
      pythonDevCommand,
      resources: config.resources,
    }),
    ...addonFilesForCreate({ ...options, add: resolvedAddons }, config.resources, { displayName, includeAgent }),
    configFile(config),
  ]
  return withProjectLock(
    targetRoot,
    process.argv.join(' '),
    async () => {
      const managedResult = await withProjectWriteLock(targetRoot, process.argv.join(' '), async (operation) => {
        const result = await writeGeneratedFiles(targetRoot, files, {
          force: options.force,
          backup: true,
        })
        const written = new Set(result.written)
        if (shouldDownloadOcrModels) {
          const checkpoint = await createPathCheckpoint(targetRoot, 'resource/base/model/ocr')
          try {
            environment.onProgress?.('Downloading OCR models...')
            const ocrResult = await updateOcrModels(targetRoot, createOcrUpdateOptions(environment))
            if (ocrResult) {
              for (const path of ocrResult.written) written.add(path)
              environment.onProgress?.('OCR models downloaded.')
            }
          } catch (error) {
            await restoreCheckpoint(checkpoint, error, 'OCR model download')
            environment.onProgress?.(
              `OCR model download failed (${errorMessage(error)}); continuing with a pending action.`,
            )
            pending = mergePending(pending, [
              ocrDownloadPending(error),
            ])
          } finally {
            await checkpoint.dispose()
          }
        }
        await writeProjectState(targetRoot, config)

        const scaffold = {
          root: targetRoot,
          config,
          written: [
            ...written,
          ],
          skipped: result.skipped,
          pending,
        }
        const afterDependencies = await maybeInstallNodeDependencies(
          scaffold,
          options,
          environment.commandRunner ?? runCommand,
          environment.installNodeDeps === true,
          environment.onProgress,
        )
        return { ...afterDependencies, backupId: operation.backupId }
      })
      const git = await maybeInitializeGit(
        targetRoot,
        options,
        managedResult.pending,
        targetInsideGitTree,
        environment.gitRunner ?? runGit,
      )
      return git ? { ...managedResult, git } : managedResult
    },
    { clearStale: options.clearStaleLock },
  )
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

export async function addDevTools(options: CliOptions, root = process.cwd()): Promise<ScaffoldResult> {
  const config = await readProjectConfig(root)
  if (hasDevTools(config)) {
    return {
      root,
      config,
      written: [],
      skipped: [],
      pending: [],
    }
  }

  config.features.vscode = { enabled: true }
  config.features.quality = { enabled: true }
  config.addons.devTools = { enabled: true }
  const files = [
    ...devToolFiles(templateInputFromConfig(config)),
    configFile(config),
  ]
  return writeAddonFiles(root, config, files, options, {
    overwriteUnmanaged: true,
    pending: [
      {
        kind: 'node-deps',
        reason: 'Node dependencies need to be installed for dev tools.',
        command: 'create-maa-project --update node-deps',
      },
    ],
  })
}

export async function addGithub(options: CliOptions, root = process.cwd()): Promise<ScaffoldResult> {
  const config = await readProjectConfig(root)
  if (!hasDevTools(config)) {
    throw new Error('--add github requires --add dev-tools first.')
  }
  if (hasGithubAutomation(config)) {
    return {
      root,
      config,
      written: [],
      skipped: [],
      pending: [],
    }
  }

  config.features.ci = { enabled: true }
  config.features.release = { enabled: true }
  config.runtime.mfa.enabled = true
  config.addons.github = { enabled: true }
  const packageJson = await readJsonObject(root, 'package.json')
  packageJson.scripts = {
    ...(isRecord(packageJson.scripts) ? packageJson.scripts : {}),
    'release:dry-run': 'node tools/build-release.mjs --dry-run',
    'sync:runtime': 'node tools/sync-runtime.mjs',
    ...(config.addons.optimizeImages ? { 'optimize:images': 'node tools/optimize-images.mjs' } : {}),
  }
  const files = [
    ...githubFiles(templateInputFromConfig(config)),
    ...(config.addons.gitCliff ? gitCliffFiles() : []),
    ...(config.addons.autoFormat ? autoFormatFiles() : []),
    ...(config.addons.optimizeImages ? optimizeImagesFiles() : []),
    {
      path: 'package.json',
      content: stableJson(packageJson),
      managed: false,
    },
    configFile(config),
  ]
  return writeAddonFiles(root, config, files, options, {
    overwriteUnmanaged: true,
    pending: [],
  })
}

export async function addAgent(_options: CliOptions, root = process.cwd()): Promise<ScaffoldResult> {
  const config = await readProjectConfig(root)
  if (config.python) {
    return {
      root,
      config,
      written: [],
      skipped: [],
      pending: [],
    }
  }

  config.project.initialTemplate = 'agent'
  const pythonDevCommand = defaultAgentDevCommand()
  config.python = {
    requiresPython: '>=3.13,<3.14',
    recommendedPython: '3.13',
  }
  config.python.devCommand = pythonDevCommand
  const interfaceJson = await readInterfaceJson(root)
  interfaceJson.agent = [
    interfaceAgent(config.python.devCommand),
  ]
  const packageJson = await readJsonObject(root, 'package.json')
  packageJson.scripts = {
    ...(isRecord(packageJson.scripts) ? packageJson.scripts : {}),
    'format:py': 'uv run --frozen ruff format .',
    'lint:py': 'uv run --frozen ruff check .',
    'typecheck:py': 'uv run --frozen pyright',
    'check:py': 'pnpm lint:py && pnpm typecheck:py',
  }
  const vscodeExtensions = await readJsonObject(root, '.vscode/extensions.json')
  const recommendations = arrayOfStrings(vscodeExtensions.recommendations)
  vscodeExtensions.recommendations = appendUnique(recommendations, [
    'windsland52.maa-log-analyzer',
    'charliermarsh.ruff',
    'ms-python.debugpy',
    'ms-python.python',
    'ms-python.vscode-pylance',
  ])
  const vscodeSettings = await readJsonObject(root, '.vscode/settings.json')
  vscodeSettings['[python]'] = {
    'editor.defaultFormatter': 'charliermarsh.ruff',
  }
  const files: ManagedFileInput[] = [
    ...agentFiles({
      slug: config.project.slug,
      version: config.project.version,
      displayName: config.project.displayName,
    }),
    ...projectCustomSchemaFiles(true),
    {
      path: 'interface.json',
      content: prettyJson(interfaceJson),
      managed: false,
    },
    {
      path: 'package.json',
      content: stableJson(packageJson),
      managed: false,
    },
    {
      path: '.vscode/extensions.json',
      content: stableJson(vscodeExtensions),
      managed: false,
    },
    {
      path: '.vscode/settings.json',
      content: stableJson(vscodeSettings),
      managed: false,
    },
    maatoolsConfigFile(
      config.resources.map((pack) => `./${pack.path}`),
      true,
    ),
    configFile(config),
  ]
  if (config.features.vscode.enabled && !(await exists(join(root, '.vscode/launch.json')))) {
    files.push(...devToolFiles(templateInputFromConfig(config)).filter((file) => file.path === '.vscode/launch.json'))
  }
  if (hasGithubAutomation(config)) {
    files.push(
      releaseWorkflowFile({
        slug: config.project.slug,
        displayName: config.project.displayName,
        includeGitCliff: Boolean(config.addons.gitCliff),
      }),
    )
  }
  if (Boolean(config.addons.dependabot)) files.push(dependabotFile(true))
  return withProjectWriteLock(
    root,
    process.argv.join(' '),
    async (operation) => {
      const result = await writeGeneratedFiles(root, files, {
        force: true,
        backup: true,
        overwriteUnmanaged: true,
      })
      await writeProjectState(root, config)

      return {
        root,
        config,
        written: result.written,
        skipped: result.skipped,
        pending: pythonPending(),
        backupId: operation.backupId,
      }
    },
    { clearStale: _options.clearStaleLock },
  )
}

export async function addResourcePack(options: CliOptions, root = process.cwd()): Promise<ScaffoldResult> {
  const config = await readProjectConfig(root)
  const slug = normalizeSlug(options.resourcePackSlug ?? options.name ?? '')
  assertValidSlug(slug)
  if (config.resources.some((pack) => pack.slug === slug)) {
    throw new Error(`Resource pack already exists: ${slug}`)
  }
  const label = requiredNonBlank(options.label ?? displayNameFromSlug(slug), 'Resource pack label cannot be blank.')
  config.resources.push({
    slug,
    label,
    path: `resource/${slug}`,
    enabled: true,
  })
  const interfaceJson = await readInterfaceJson(root)
  interfaceJson.resource = interfaceResourceItems(config.resources)
  const resourcePaths = config.resources.map((pack) => `./${pack.path}`)
  const files: ManagedFileInput[] = [
    {
      path: 'interface.json',
      content: prettyJson(interfaceJson),
      managed: false,
    },
    {
      path: `resource/${slug}/pipeline/.gitkeep`,
      content: '',
      managed: false,
    },
    {
      path: `resource/${slug}/image/empty.png`,
      content: emptyPng(),
      managed: false,
    },
    maatoolsConfigFile(resourcePaths, Boolean(config.python)),
    configFile(config),
  ]

  return withProjectWriteLock(
    root,
    process.argv.join(' '),
    async (operation) => {
      const result = await writeGeneratedFiles(root, files, {
        force: true,
        backup: true,
        overwriteUnmanaged: true,
      })
      await writeProjectState(root, config)

      return {
        root,
        config,
        written: result.written,
        skipped: result.skipped,
        pending: [],
        backupId: operation.backupId,
      }
    },
    { clearStale: options.clearStaleLock },
  )
}

export async function addGitCliff(_options: CliOptions, root = process.cwd()): Promise<ScaffoldResult> {
  const config = await readProjectConfig(root)
  config.addons.gitCliff = { enabled: true }
  const files: ManagedFileInput[] = [
    ...gitCliffFiles(),
    configFile(config),
  ]
  if (hasGithubAutomation(config)) {
    files.push(releaseWorkflowFile(templateInputFromConfig(config)))
  }
  return writeAddonFiles(root, config, files, _options)
}

export async function addAutoFormat(options: CliOptions, root = process.cwd()): Promise<ScaffoldResult> {
  const config = await readProjectConfig(root)
  config.addons.autoFormat = { enabled: true }
  return writeAddonFiles(
    root,
    config,
    [
      ...autoFormatFiles(),
      configFile(config),
    ],
    options,
  )
}

export async function addOptimizeImages(options: CliOptions, root = process.cwd()): Promise<ScaffoldResult> {
  const config = await readProjectConfig(root)
  config.addons.optimizeImages = { enabled: true }

  const packageJson = await readJsonObject(root, 'package.json')
  packageJson.scripts = {
    ...(isRecord(packageJson.scripts) ? packageJson.scripts : {}),
    'optimize:images': 'node tools/optimize-images.mjs',
  }

  return writeAddonFiles(
    root,
    config,
    [
      ...optimizeImagesFiles(),
      {
        path: 'package.json',
        content: stableJson(packageJson),
        managed: false,
      },
      configFile(config),
    ],
    options,
    { overwriteUnmanaged: true },
  )
}

export async function addDependabot(options: CliOptions, root = process.cwd()): Promise<ScaffoldResult> {
  const config = await readProjectConfig(root)
  config.addons.dependabot = { enabled: true }
  return writeAddonFiles(
    root,
    config,
    [
      dependabotFile(config.python !== undefined),
      configFile(config),
    ],
    options,
  )
}

export async function addCommunity(options: CliOptions, root = process.cwd()): Promise<ScaffoldResult> {
  const config = await readProjectConfig(root)
  config.addons.community = { enabled: true }
  return writeAddonFiles(
    root,
    config,
    [
      ...communityFiles({
        displayName: config.project.displayName,
      }),
      configFile(config),
    ],
    options,
  )
}

export async function addSchemaSync(options: CliOptions, root = process.cwd()): Promise<ScaffoldResult> {
  const config = await readProjectConfig(root)
  config.addons.schemaSync = { enabled: true }

  const packageJson = await readJsonObject(root, 'package.json')
  packageJson.scripts = {
    ...(isRecord(packageJson.scripts) ? packageJson.scripts : {}),
    'sync:schema': 'node tools/sync-schema.mjs',
  }

  return writeAddonFiles(
    root,
    config,
    [
      ...schemaSyncFiles(),
      {
        path: 'package.json',
        content: stableJson(packageJson),
        managed: false,
      },
      configFile(config),
    ],
    options,
    { overwriteUnmanaged: true },
  )
}

function createConfig(input: {
  slug: string
  displayName: string
  version: string
  includeAgent: boolean
  pythonDevCommand?: string[] | undefined
  options: CliOptions
  resolvedAddons: string[]
}): MaaProjectConfig {
  const includeDevTools = input.resolvedAddons.includes('dev-tools')
  const includeGithub = input.resolvedAddons.includes('github')
  const config: MaaProjectConfig = {
    schemaVersion: 2,
    project: {
      slug: input.slug,
      displayName: input.displayName,
      version: input.version,
      initialTemplate: input.includeAgent ? 'agent' : 'pipeline',
    },
    features: {
      ci: { enabled: includeGithub },
      release: { enabled: includeGithub },
      vscode: { enabled: includeDevTools },
      quality: { enabled: includeDevTools },
    },
    addons: initialAddons(input.resolvedAddons),
    controller: {
      kinds: input.options.controllers ?? DEFAULT_CONTROLLER_KINDS,
    },
    resources: initialResources(input.options),
    maafw: {
      channel: 'stable',
      version: '',
    },
    runtime: {
      mfa: {
        channel: 'stable',
        version: '',
        enabled: includeGithub,
      },
    },
    network: {
      mode: input.options.network ?? 'auto',
    },
    license: {
      spdx: input.options.license ?? 'AGPL-3.0-or-later',
    },
  }
  if (input.includeAgent) {
    config.python = {
      requiresPython: '>=3.13,<3.14',
      recommendedPython: '3.13',
    }
    config.python.devCommand = input.pythonDevCommand ?? defaultAgentDevCommand()
  }
  return config
}

async function writeAddonFiles(
  root: string,
  config: MaaProjectConfig,
  files: ManagedFileInput[],
  options: CliOptions,
  writeOptions: { overwriteUnmanaged?: boolean; pending?: PendingItem[] } = {},
): Promise<ScaffoldResult> {
  return withProjectWriteLock(
    root,
    process.argv.join(' '),
    async (operation) => {
      const result = await writeGeneratedFiles(root, files, {
        force: true,
        backup: true,
        ...(writeOptions.overwriteUnmanaged ? { overwriteUnmanaged: true } : {}),
      })
      await writeProjectState(root, config)

      return {
        root,
        config,
        written: result.written,
        skipped: result.skipped,
        pending: writeOptions.pending ?? [],
        backupId: operation.backupId,
      }
    },
    { clearStale: options.clearStaleLock },
  )
}

function initialAddons(addons: string[]): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  if (addons.includes('dev-tools')) state.devTools = { enabled: true }
  if (addons.includes('github')) state.github = { enabled: true }
  if (addons.includes('git-cliff')) state.gitCliff = { enabled: true }
  if (addons.includes('auto-format')) state.autoFormat = { enabled: true }
  if (addons.includes('optimize-images')) state.optimizeImages = { enabled: true }
  if (addons.includes('dependabot')) state.dependabot = { enabled: true }
  if (addons.includes('community')) state.community = { enabled: true }
  if (addons.includes('schema-sync')) state.schemaSync = { enabled: true }
  return state
}

function initialResources(options: CliOptions): MaaProjectConfig['resources'] {
  const resources: MaaProjectConfig['resources'] = [
    {
      slug: 'base',
      label: 'Base',
      path: 'resource/base',
      enabled: true,
    },
  ]
  if (!options.add.includes('resource-pack')) return resources
  const slug = normalizeSlug(options.resourcePackSlug ?? '')
  if (!slug) throw new Error('Resource pack folder cannot be blank.')
  assertValidSlug(slug)
  resources.push({
    slug,
    label: requiredNonBlank(options.label ?? displayNameFromSlug(slug), 'Resource pack display name cannot be blank.'),
    path: `resource/${slug}`,
    enabled: true,
  })
  return resources
}

function addonFilesForCreate(
  options: CliOptions,
  resources: MaaProjectConfig['resources'],
  input: { displayName: string; includeAgent: boolean },
): ManagedFileInput[] {
  const files: ManagedFileInput[] = []
  for (const pack of resources.slice(1)) {
    files.push(
      {
        path: `${pack.path}/pipeline/.gitkeep`,
        content: '',
        managed: false,
      },
      {
        path: `${pack.path}/image/empty.png`,
        content: emptyPng(),
        managed: false,
      },
    )
  }
  const addons = options.add
  if (addons.includes('dependabot')) files.push(dependabotFile(input.includeAgent))
  if (addons.includes('community')) files.push(...communityFiles(input))
  return files
}

function templateInputFromConfig(config: MaaProjectConfig): Parameters<typeof devToolFiles>[0] {
  return {
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
    resources: config.resources,
  }
}

export async function assertCanCreateTarget(
  targetRoot: string,
  options: CliOptions,
  detectGitTree: (path: string) => Promise<boolean> = isInsideGitTree,
): Promise<void> {
  const entries = await listDirectoryEntries(targetRoot)
  if (entries.length === 0) return
  if (!options.force) {
    throw new Error(
      `Target directory is not empty: ${targetRoot}. Use --force to write missing files and replace existing generated files.`,
    )
  }
  const hasGit = await detectGitTree(targetRoot)
  if (!hasGit && !options.allowNonGitDir) {
    throw new Error(
      'Refusing to write into a non-empty directory without Git protection. Re-run with --allow-non-git-dir after making a backup.',
    )
  }
}

async function isInsideGitTree(path: string): Promise<boolean> {
  let current = path
  for (;;) {
    if (await exists(join(current, '.git'))) return true
    const parent = resolve(current, '..')
    if (parent === current) return false
    current = parent
  }
}

async function maybeInitializeGit(
  root: string,
  options: CliOptions,
  pending: PendingItem[],
  targetInsideGitTree: boolean,
  gitRunner: GitRunner,
): Promise<GitInitResult | undefined> {
  if (options.initializeGit !== true) return undefined
  if (targetInsideGitTree) {
    return {
      initialized: false,
      committed: false,
      reason: 'target is inside an existing Git repository',
    }
  }

  const gitDirectory = join(root, '.git')
  const gitDirectoryExisted = await exists(gitDirectory)
  try {
    await gitRunner(root, [
      'init',
    ])
  } catch (error) {
    let initialized = await exists(gitDirectory)
    let cleanupFailure: unknown
    if (initialized && !gitDirectoryExisted) {
      try {
        await rm(gitDirectory, { force: true, recursive: true })
        initialized = false
      } catch (cleanupError) {
        cleanupFailure = cleanupError
      }
    }
    return {
      initialized,
      committed: false,
      reason:
        initialized && gitDirectoryExisted
          ? `git init failed: ${errorMessage(error)}. The pre-existing .git directory was left unchanged; inspect it before retrying.`
          : initialized
            ? `git init failed: ${errorMessage(error)}. The new .git directory could not be cleaned up (${errorMessage(cleanupFailure)}); inspect it before retrying.`
            : `git init failed: ${errorMessage(error)}. Any newly created partial .git directory was removed; project files remain available; run git init and create the initial commit manually.`,
    }
  }
  try {
    await ensureLocalGitExcludes(root)
  } catch (error) {
    return {
      initialized: true,
      committed: false,
      reason: `Git was initialized, but local project state could not be excluded (${errorMessage(error)}). Add /.create-maa-project/ and /node_modules/ to .git/info/exclude before staging files.`,
    }
  }
  if (pending.length > 0 && !options.allowPendingCommit) {
    return {
      initialized: true,
      committed: false,
      reason: 'project has pending actions',
    }
  }

  try {
    await gitRunner(root, [
      'add',
      '--all',
      '--',
      '.',
      ':(exclude).create-maa-project',
      ':(exclude).create-maa-project/**',
      ':(exclude)node_modules',
      ':(exclude)node_modules/**',
    ])
  } catch (error) {
    return {
      initialized: true,
      committed: false,
      reason: `git add . failed: ${errorMessage(error)}. Run git status, then git add . and git commit manually.`,
    }
  }
  try {
    await gitRunner(root, [
      'commit',
      '-m',
      'chore: scaffold MaaFW project',
    ])
  } catch (error) {
    return {
      initialized: true,
      committed: false,
      reason: `git commit failed: ${errorMessage(error)}. Files remain staged; configure Git user.name and user.email if needed, then run git commit manually.`,
    }
  }
  return {
    initialized: true,
    committed: true,
  }
}

async function ensureLocalGitExcludes(root: string): Promise<void> {
  const gitDirectory = join(root, '.git')
  if (!(await exists(gitDirectory))) return
  const excludePath = join(gitDirectory, 'info', 'exclude')
  const current = (await exists(excludePath)) ? await readText(excludePath) : ''
  const lines = new Set(current.split(/\r?\n/u))
  const missing = [
    '/.create-maa-project/',
    '/node_modules/',
  ].filter((line) => !lines.has(line))
  if (missing.length === 0) return
  const prefix = current.length === 0 || current.endsWith('\n') ? current : `${current}\n`
  await mkdir(dirname(excludePath), { recursive: true })
  await writeText(excludePath, `${prefix}${missing.join('\n')}\n`)
}

async function runGit(root: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: root })
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

async function maybeInstallNodeDependencies(
  scaffold: ScaffoldResult,
  options: CliOptions,
  commandRunner: CommandRunner,
  enabled: boolean,
  onProgress?: ProgressReporter,
): Promise<ScaffoldResult> {
  if (!enabled || options.skipDownload || !scaffold.pending.some((item) => item.kind === 'node-deps')) {
    return scaffold
  }

  const root = scaffold.root
  const config = scaffold.config
  let pending = scaffold.pending
  const written = new Set(scaffold.written)
  const trackedPaths = [
    'node_modules',
    'pnpm-lock.yaml',
  ]
  for (const path of trackedPaths) await trackProjectPathForBackup(root, path)
  try {
    onProgress?.('Installing Node dependencies...')
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
    onProgress?.('Node dependencies installed.')
    pending = pending.filter((item) => item.kind !== 'node-deps')
    if (await exists(join(root, 'pnpm-lock.yaml'))) {
      written.add('pnpm-lock.yaml')
    }
  } catch (error) {
    try {
      await restoreTrackedProjectPaths(root, trackedPaths)
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        'Node dependency installation failed and its partial files could not be restored.',
      )
    }
    onProgress?.(`Node dependency install failed (${errorMessage(error)}); continuing with a pending action.`)
    pending = replacePending(pending, {
      kind: 'node-deps',
      reason: `pnpm install failed during project creation: ${errorMessage(error)}`,
      command: 'create-maa-project --update node-deps',
    })
  }

  await withProjectWriteLock(
    root,
    process.argv.join(' '),
    async () => {
      await writeProjectState(root, config)
    },
    { clearStale: options.clearStaleLock },
  )
  written.add('maa-project.json')
  return {
    ...scaffold,
    written: [
      ...written,
    ],
    pending,
  }
}

async function createPathCheckpoint(
  root: string,
  relativePath: string,
): Promise<{ restore: () => Promise<void>; dispose: () => Promise<void> }> {
  const source = join(root, relativePath)
  const sourceExists = await exists(source)
  const checkpointRoot = await mkdtemp(join(tmpdir(), `create-maa-project-checkpoint-${randomUUID()}-`))
  const checkpoint = join(checkpointRoot, 'content')
  if (sourceExists) {
    await mkdir(checkpointRoot, { recursive: true })
    await cp(source, checkpoint, { recursive: true, force: true, verbatimSymlinks: true })
  }
  return {
    restore: async () => {
      await rm(source, { force: true, recursive: true })
      if (sourceExists) {
        await mkdir(dirname(source), { recursive: true })
        await cp(checkpoint, source, { recursive: true, force: true, verbatimSymlinks: true })
      }
    },
    dispose: () => rm(checkpointRoot, { force: true, recursive: true }),
  }
}

async function restoreCheckpoint(
  checkpoint: { restore: () => Promise<void> },
  originalError: unknown,
  label: string,
): Promise<void> {
  try {
    await checkpoint.restore()
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      `${label} failed and its project files could not be restored.`,
    )
  }
}

function replacePending(pending: PendingItem[], next: PendingItem): PendingItem[] {
  return [
    ...pending.filter((item) => item.kind !== next.kind),
    next,
  ]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultPending(input: {
  includeAgent: boolean
  includeDevTools: boolean
  options: CliOptions
  includeOcrPending?: boolean
}): PendingItem[] {
  const pending: PendingItem[] = []
  if (input.includeDevTools) {
    pending.push({
      kind: 'node-deps',
      reason: 'Generated project dependencies are pinned in package.json but not installed by the scaffold.',
      command: 'create-maa-project --update node-deps',
    })
  }
  if (input.includeOcrPending !== false && input.options.skipDownload) {
    pending.push({
      kind: 'ocr-model',
      reason: 'OCR model download was skipped.',
      command: 'create-maa-project --update ocr-models',
    })
  } else if (input.includeOcrPending !== false) {
    pending.push({
      kind: 'ocr-model',
      reason: 'OCR model manifest source is not configured.',
      command: 'create-maa-project --update ocr-models',
    })
  }
  if (input.includeAgent) {
    pending.push(...pythonPending())
  }
  return pending
}

function ocrDownloadPending(error: unknown): PendingItem {
  return {
    kind: 'ocr-model',
    reason: `OCR model download failed during project creation: ${errorMessage(error)}`,
    command: 'create-maa-project --update ocr-models',
  }
}

function pythonPending(): PendingItem[] {
  return [
    {
      kind: 'python-deps',
      reason: 'Agent dependencies are managed by uv and need to be synchronized locally.',
      command: 'create-maa-project --update python-deps',
    },
  ]
}

function requiredNonBlank(value: string, message: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(message)
  return normalized
}

function displayNameFromSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

async function readInterfaceJson(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readText(join(root, 'interface.json'))) as Record<string, unknown>
}

async function readJsonObject(root: string, path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readText(join(root, path))) as Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function appendUnique(existing: string[], values: string[]): string[] {
  const set = new Set(existing)
  for (const value of values) set.add(value)
  return [
    ...set,
  ]
}
