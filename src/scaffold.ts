import { execFile, spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
    agentFiles,
    autoFormatFiles,
    baseProjectFiles,
    configFile,
    communityFiles,
    dependabotFile,
    devToolFiles,
    emptyPng,
    gitCliffFiles,
    githubFiles,
    interfaceAgent,
    interfaceResourceItems,
    maatoolsConfigFile,
    projectCustomSchemaFiles,
    releaseWorkflowFile,
    schemaSyncFiles
} from './templates.js'
import type {
    CliOptions,
    GitInitResult,
    MaaProjectConfig,
    ManagedFileInput,
    PendingItem,
    ScaffoldResult
} from './types.js'
import {
    assertValidSlug,
    exists,
    normalizeSlug,
    nowIso,
    prettyJson,
    readText,
    stableJson,
    stripV
} from './utils.js'
import {
    backupProjectSnapshot,
    emptyLock,
    listDirectoryEntries,
    mergePending,
    readProjectConfig,
    readProjectLock,
    refreshManagedFileContent,
    withProjectWriteLock,
    writeGeneratedFiles,
    writeProjectState
} from './project.js'
import { assertSupportedCreateAddons, resolveAddonDependencies } from './addons.js'
import {
    resolveOcrManifestFromEnvironment,
    type AssetDownloader,
    type AssetManifestResolver,
    type DownloadProgressReporter
} from './assets.js'
import { DEFAULT_CONTROLLER_KINDS, projectControllerKinds } from './controllers.js'
import { hasDevTools, hasGithubAutomation } from './features.js'
import { updateOcrModels } from './update.js'

const CLI_VERSION = '0.1.0'
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
    } = {}
): Promise<ScaffoldResult> {
    assertSupportedCreateAddons(options.add)
    const targetRoot = resolve(process.cwd(), options.name ?? '.')
    const detectGitTree = environment.detectGitTree ?? isInsideGitTree
    const targetInsideGitTree = await detectGitTree(targetRoot)
    const defaultName = options.name && options.name !== '.' ? basename(options.name) : basename(targetRoot)
    const slug = options.slug ? normalizeSlug(options.slug) : normalizeSlug(defaultName)
    if (!slug) {
        throw new Error(
            `Project ID cannot be inferred from "${defaultName}". Use --slug with an ASCII kebab-case value, and pass --name for the display name.`
        )
    }
    assertValidSlug(slug)
    const displayName = requiredNonBlank(
        options.displayName ?? options.label ?? defaultName,
        'Project display name cannot be blank.'
    )
    const version = stripV(options.version ?? '0.1.0')
    assertValidVersion(version)

    const targetHadEntries = (await listDirectoryEntries(targetRoot)).length > 0
    await assertCanCreateTarget(targetRoot, options, detectGitTree)
    await mkdir(targetRoot, { recursive: true })

    const includeAgent = options.template === 'agent' || options.add.includes('agent')
    const resolvedAddons = resolveAddonDependencies(options.add, { includeAgent })
    const includeDevTools = resolvedAddons.includes('dev-tools')
    const includeGithub = resolvedAddons.includes('github')
    const pythonDevCommand = includeAgent ? await detectPythonDevCommand() : undefined
    const config = createConfig({
        slug,
        displayName,
        version,
        includeAgent,
        pythonDevCommand,
        options,
        resolvedAddons
    })
    const shouldDownloadOcrModels = environment.downloadOcrModels === true && !options.skipDownload
    const pending = defaultPending({
        includeAgent,
        options,
        includeDevTools,
        pythonDevCommand,
        includeOcrPending: !shouldDownloadOcrModels
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
            includeSchemaSync: resolvedAddons.includes('schema-sync'),
            pythonDevCommand,
            resources: config.resources
        }),
        ...addonFilesForCreate({ ...options, add: resolvedAddons }, config.resources, { displayName }),
        configFile(config)
    ]
    const lock = emptyLock(CLI_VERSION)
    const scaffold = await withProjectWriteLock(
        targetRoot,
        process.argv.join(' '),
        async () => {
            if (targetHadEntries) {
                await backupProjectSnapshot(targetRoot)
            }
            const result = await writeGeneratedFiles(targetRoot, files, {
                force: options.force,
                backup: true
            })
            const written = new Set(result.written)
            Object.assign(lock.managedFiles, result.lockEntries)
            for (const file of files) {
                if (!file.managed && result.written.includes(file.path)) {
                    lock.createdFiles[file.path] = {
                        createdAt: nowIso(),
                        managed: false
                    }
                }
            }
            lock.pending = pending
            if (shouldDownloadOcrModels) {
                try {
                    environment.onProgress?.('Downloading OCR models...')
                    const ocrResult = await updateOcrModels(targetRoot, createOcrUpdateOptions(environment))
                    if (ocrResult) {
                        for (const path of ocrResult.written) written.add(path)
                        for (const path of await refreshManagedFileContent(targetRoot, lock, ocrResult.files)) {
                            written.add(path)
                        }
                        environment.onProgress?.('OCR models downloaded.')
                    }
                } catch (error) {
                    environment.onProgress?.(
                        `OCR model download failed (${errorMessage(error)}); continuing with a pending action.`
                    )
                    lock.pending = mergePending(lock.pending, [ocrDownloadPending(error)])
                }
            }
            await writeProjectState(targetRoot, config, lock)

            return {
                root: targetRoot,
                config,
                lock,
                written: [...written],
                skipped: result.skipped,
                pending: lock.pending
            }
        },
        { clearStale: options.clearStaleLock }
    )
    const afterDependencies = await maybeInstallNodeDependencies(
        scaffold,
        options,
        environment.commandRunner ?? runCommand,
        environment.installNodeDeps === true,
        environment.onProgress
    )
    const git = await maybeInitializeGit(
        targetRoot,
        options,
        afterDependencies.pending,
        targetInsideGitTree,
        environment.gitRunner ?? runGit
    )
    return git ? { ...afterDependencies, git } : afterDependencies
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

export async function addDevTools(options: CliOptions): Promise<ScaffoldResult> {
    const root = process.cwd()
    const config = await readProjectConfig(root)
    const lock = await readProjectLock(root)
    if (hasDevTools(config)) {
        return {
            root,
            config,
            lock,
            written: [],
            skipped: [],
            pending: lock.pending
        }
    }

    config.features.vscode = { enabled: true }
    config.features.quality = { enabled: true }
    config.addons.devTools = { enabled: true }
    const files = [
        ...devToolFiles(templateInputFromConfig(config)),
        configFile(config)
    ]
    return writeAddonFiles(root, config, lock, files, options, {
        overwriteUnmanaged: true,
        pending: [
            {
                kind: 'node-deps',
                reason: 'Node dependencies need to be installed for dev tools.',
                command: 'create-maa-project --update node-deps'
            }
        ]
    })
}

export async function addGithub(options: CliOptions): Promise<ScaffoldResult> {
    const root = process.cwd()
    const config = await readProjectConfig(root)
    const lock = await readProjectLock(root)
    if (!hasDevTools(config)) {
        throw new Error('--add github requires --add dev-tools first.')
    }
    if (hasGithubAutomation(config)) {
        return {
            root,
            config,
            lock,
            written: [],
            skipped: [],
            pending: lock.pending
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
        'sync:runtime': 'node tools/sync-runtime.mjs'
    }
    const files = [
        ...githubFiles(templateInputFromConfig(config)),
        ...(config.addons.gitCliff ? gitCliffFiles() : []),
        ...(config.addons.autoFormat ? autoFormatFiles() : []),
        {
            path: 'package.json',
            content: stableJson(packageJson),
            managed: false
        },
        configFile(config)
    ]
    return writeAddonFiles(root, config, lock, files, options, { overwriteUnmanaged: true })
}

export async function addAgent(_options: CliOptions): Promise<ScaffoldResult> {
    const root = process.cwd()
    const config = await readProjectConfig(root)
    const lock = await readProjectLock(root)
    if (config.python) {
        return {
            root,
            config,
            lock,
            written: [],
            skipped: [],
            pending: lock.pending
        }
    }

    config.project.initialTemplate = 'agent'
    const pythonDevCommand = await detectPythonDevCommand()
    config.python = {
        requiresPython: '>=3.11,<3.14',
        recommendedPython: '3.13'
    }
    if (pythonDevCommand) config.python.devCommand = pythonDevCommand
    const interfaceJson = await readInterfaceJson(root)
    interfaceJson.agent = [
        interfaceAgent(config.project.slug, config.python.devCommand)
    ]
    const packageJson = await readJsonObject(root, 'package.json')
    packageJson.scripts = {
        ...(isRecord(packageJson.scripts) ? packageJson.scripts : {}),
        'format:py': 'uv run --frozen ruff format .',
        'lint:py': 'uv run --frozen ruff check .',
        'typecheck:py': 'uv run --frozen pyright',
        'check:py': 'pnpm lint:py && pnpm typecheck:py'
    }
    const vscodeExtensions = await readJsonObject(root, '.vscode/extensions.json')
    const recommendations = arrayOfStrings(vscodeExtensions.recommendations)
    vscodeExtensions.recommendations = appendUnique(recommendations, [
        'charliermarsh.ruff',
        'ms-python.python',
        'ms-python.vscode-pylance'
    ])
    const vscodeSettings = await readJsonObject(root, '.vscode/settings.json')
    vscodeSettings['python.defaultInterpreterPath'] = '${workspaceFolder}/.venv/bin/python'
    vscodeSettings['[python]'] = {
        'editor.defaultFormatter': 'charliermarsh.ruff'
    }
    const files: ManagedFileInput[] = [
        ...agentFiles({
            slug: config.project.slug,
            version: config.project.version
        }),
        ...projectCustomSchemaFiles(true),
        {
            path: 'interface.json',
            content: prettyJson(interfaceJson),
            managed: false
        },
        {
            path: 'package.json',
            content: stableJson(packageJson),
            managed: false
        },
        {
            path: '.vscode/extensions.json',
            content: stableJson(vscodeExtensions),
            managed: false
        },
        {
            path: '.vscode/settings.json',
            content: stableJson(vscodeSettings),
            managed: false
        },
        configFile(config)
    ]
    if (hasGithubAutomation(config)) {
        files.push(releaseWorkflowFile({
            slug: config.project.slug,
            includeGitCliff: Boolean(config.addons.gitCliff)
        }))
    }
    return withProjectWriteLock(
        root,
        process.argv.join(' '),
        async () => {
            const result = await writeGeneratedFiles(root, files, {
                force: true,
                backup: true,
                overwriteUnmanaged: true
            })
            Object.assign(lock.managedFiles, result.lockEntries)
            recordCreatedFiles(lock, files, result.written)
            lock.pending = mergePending(lock.pending, pythonPending(pythonDevCommand))
            lock.template.lastUpdatedBy = 'create-maa-project'
            lock.template.templateVersion = CLI_VERSION
            await writeProjectState(root, config, lock)

            return {
                root,
                config,
                lock,
                written: result.written,
                skipped: result.skipped,
                pending: lock.pending
            }
        },
        { clearStale: _options.clearStaleLock }
    )
}

export async function addResourcePack(options: CliOptions): Promise<ScaffoldResult> {
    const root = process.cwd()
    const config = await readProjectConfig(root)
    const lock = await readProjectLock(root)
    const slug = normalizeSlug(options.resourcePackSlug ?? options.name ?? '')
    assertValidSlug(slug)
    if (config.resources.some((pack) => pack.slug === slug)) {
        throw new Error(`Resource pack already exists: ${slug}`)
    }
    const label = requiredNonBlank(
        options.label ?? displayNameFromSlug(slug),
        'Resource pack label cannot be blank.'
    )
    config.resources.push({
        slug,
        label,
        path: `resource/${slug}`,
        enabled: true
    })
    const interfaceJson = await readInterfaceJson(root)
    interfaceJson.resource = interfaceResourceItems(config.resources)
    const resourcePaths = config.resources.map((pack) => `./${pack.path}`)
    const files: ManagedFileInput[] = [
        {
            path: 'interface.json',
            content: prettyJson(interfaceJson),
            managed: false
        },
        {
            path: `resource/${slug}/pipeline/.gitkeep`,
            content: '',
            managed: false
        },
        {
            path: `resource/${slug}/image/empty.png`,
            content: emptyPng(),
            managed: false
        },
        maatoolsConfigFile(resourcePaths),
        configFile(config)
    ]

    return withProjectWriteLock(
        root,
        process.argv.join(' '),
        async () => {
            const result = await writeGeneratedFiles(root, files, {
                force: true,
                backup: true,
                overwriteUnmanaged: true
            })
            Object.assign(lock.managedFiles, result.lockEntries)
            recordCreatedFiles(lock, files, result.written)
            lock.template.lastUpdatedBy = 'create-maa-project'
            lock.template.templateVersion = CLI_VERSION
            await writeProjectState(root, config, lock)

            return {
                root,
                config,
                lock,
                written: result.written,
                skipped: result.skipped,
                pending: lock.pending
            }
        },
        { clearStale: options.clearStaleLock }
    )
}

export async function addGitCliff(_options: CliOptions): Promise<ScaffoldResult> {
    const root = process.cwd()
    const config = await readProjectConfig(root)
    const lock = await readProjectLock(root)
    config.addons.gitCliff = { enabled: true }
    const files: ManagedFileInput[] = [
        ...gitCliffFiles(),
        configFile(config)
    ]
    if (hasGithubAutomation(config)) {
        files.push(releaseWorkflowFile(templateInputFromConfig(config)))
    }
    return writeAddonFiles(
        root,
        config,
        lock,
        files,
        _options
    )
}

export async function addAutoFormat(options: CliOptions): Promise<ScaffoldResult> {
    const root = process.cwd()
    const config = await readProjectConfig(root)
    const lock = await readProjectLock(root)
    config.addons.autoFormat = { enabled: true }
    return writeAddonFiles(root, config, lock, [...autoFormatFiles(), configFile(config)], options)
}

export async function addDependabot(options: CliOptions): Promise<ScaffoldResult> {
    const root = process.cwd()
    const config = await readProjectConfig(root)
    const lock = await readProjectLock(root)
    config.addons.dependabot = { enabled: true }
    return writeAddonFiles(root, config, lock, [dependabotFile(), configFile(config)], options)
}

export async function addCommunity(options: CliOptions): Promise<ScaffoldResult> {
    const root = process.cwd()
    const config = await readProjectConfig(root)
    const lock = await readProjectLock(root)
    config.addons.community = { enabled: true }
    return writeAddonFiles(
        root,
        config,
        lock,
        [
            ...communityFiles({
                displayName: config.project.displayName
            }),
            configFile(config)
        ],
        options
    )
}

export async function addSchemaSync(options: CliOptions): Promise<ScaffoldResult> {
    const root = process.cwd()
    const config = await readProjectConfig(root)
    const lock = await readProjectLock(root)
    config.addons.schemaSync = { enabled: true }

    const packageJson = await readJsonObject(root, 'package.json')
    packageJson.scripts = {
        ...(isRecord(packageJson.scripts) ? packageJson.scripts : {}),
        'sync:schema': 'node tools/sync-schema.mjs'
    }

    return writeAddonFiles(
        root,
        config,
        lock,
        [
            ...schemaSyncFiles(),
            {
                path: 'package.json',
                content: stableJson(packageJson),
                managed: false
            },
            configFile(config)
        ],
        options,
        { overwriteUnmanaged: true }
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
        schemaVersion: 1,
        project: {
            slug: input.slug,
            displayName: input.displayName,
            version: input.version,
            initialTemplate: input.includeAgent ? 'agent' : 'pipeline'
        },
        features: {
            ci: { enabled: includeGithub },
            release: { enabled: includeGithub },
            vscode: { enabled: includeDevTools },
            quality: { enabled: includeDevTools }
        },
        addons: initialAddons(input.resolvedAddons),
        controller: {
            kinds: input.options.controllers ?? DEFAULT_CONTROLLER_KINDS
        },
        resources: initialResources(input.options),
        maafw: {
            channel: 'latest'
        },
        runtime: {
            mfa: {
                channel: 'latest',
                enabled: includeGithub
            }
        },
        network: {
            mode: input.options.network ?? 'auto'
        },
        license: {
            spdx: input.options.license ?? 'AGPL-3.0-or-later'
        }
    }
    if (input.includeAgent) {
        config.python = {
            requiresPython: '>=3.11,<3.14',
            recommendedPython: '3.13'
        }
        if (input.pythonDevCommand) config.python.devCommand = input.pythonDevCommand
    }
    return config
}

async function writeAddonFiles(
    root: string,
    config: MaaProjectConfig,
    lock: Awaited<ReturnType<typeof readProjectLock>>,
    files: ManagedFileInput[],
    options: CliOptions,
    writeOptions: { overwriteUnmanaged?: boolean; pending?: PendingItem[] } = {}
): Promise<ScaffoldResult> {
    return withProjectWriteLock(
        root,
        process.argv.join(' '),
        async () => {
            const result = await writeGeneratedFiles(root, files, {
                force: true,
                backup: true,
                ...(writeOptions.overwriteUnmanaged ? { overwriteUnmanaged: true } : {})
            })
            Object.assign(lock.managedFiles, result.lockEntries)
            recordCreatedFiles(lock, files, result.written)
            if (writeOptions.pending) {
                lock.pending = mergePending(lock.pending, writeOptions.pending)
            }
            lock.template.lastUpdatedBy = 'create-maa-project'
            lock.template.templateVersion = CLI_VERSION
            await writeProjectState(root, config, lock)

            return {
                root,
                config,
                lock,
                written: result.written,
                skipped: result.skipped,
                pending: lock.pending
            }
        },
        { clearStale: options.clearStaleLock }
    )
}

function recordCreatedFiles(
    lock: Awaited<ReturnType<typeof readProjectLock>>,
    files: ManagedFileInput[],
    written: string[]
): void {
    for (const file of files) {
        if (!file.managed && written.includes(file.path)) {
            lock.createdFiles[file.path] = {
                createdAt: nowIso(),
                managed: false
            }
        }
    }
}

function initialAddons(addons: string[]): Record<string, unknown> {
    const state: Record<string, unknown> = {}
    if (addons.includes('dev-tools')) state.devTools = { enabled: true }
    if (addons.includes('github')) state.github = { enabled: true }
    if (addons.includes('git-cliff')) state.gitCliff = { enabled: true }
    if (addons.includes('auto-format')) state.autoFormat = { enabled: true }
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
            enabled: true
        }
    ]
    if (!options.add.includes('resource-pack')) return resources
    const slug = normalizeSlug(options.resourcePackSlug ?? '')
    if (!slug) throw new Error('Resource pack folder cannot be blank.')
    assertValidSlug(slug)
    resources.push({
        slug,
        label: requiredNonBlank(
            options.label ?? displayNameFromSlug(slug),
            'Resource pack display name cannot be blank.'
        ),
        path: `resource/${slug}`,
        enabled: true
    })
    return resources
}

function addonFilesForCreate(
    options: CliOptions,
    resources: MaaProjectConfig['resources'],
    input: { displayName: string }
): ManagedFileInput[] {
    const files: ManagedFileInput[] = []
    for (const pack of resources.slice(1)) {
        files.push(
            {
                path: `${pack.path}/pipeline/.gitkeep`,
                content: '',
                managed: false
            },
            {
                path: `${pack.path}/image/empty.png`,
                content: emptyPng(),
                managed: false
            }
        )
    }
    const addons = options.add
    if (addons.includes('dependabot')) files.push(dependabotFile())
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
        includeSchemaSync: Boolean(config.addons.schemaSync),
        pythonDevCommand: config.python?.devCommand,
        resources: config.resources
    }
}

export async function assertCanCreateTarget(
    targetRoot: string,
    options: CliOptions,
    detectGitTree: (path: string) => Promise<boolean> = isInsideGitTree
): Promise<void> {
    const entries = await listDirectoryEntries(targetRoot)
    if (entries.length === 0) return
    if (!options.force) {
        throw new Error(
            `Target directory is not empty: ${targetRoot}. Use --force to write missing files and replace existing generated files.`
        )
    }
    const hasGit = await detectGitTree(targetRoot)
    if (!hasGit && !options.allowNonGitDir) {
        throw new Error(
            'Refusing to write into a non-empty directory without Git protection. Re-run with --allow-non-git-dir after making a backup.'
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
    gitRunner: GitRunner
): Promise<GitInitResult | undefined> {
    if (options.initializeGit !== true) return undefined
    if (targetInsideGitTree) {
        return {
            initialized: false,
            committed: false,
            reason: 'target is inside an existing Git repository'
        }
    }

    await gitRunner(root, ['init'])
    if (pending.length > 0 && !options.allowPendingCommit) {
        return {
            initialized: true,
            committed: false,
            reason: 'project has pending actions'
        }
    }

    await gitRunner(root, ['add', '.'])
    await gitRunner(root, ['commit', '-m', 'chore: scaffold MaaFW project'])
    return {
        initialized: true,
        committed: true
    }
}

async function runGit(root: string, args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd: root })
}

async function runCommand(root: string, command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: root,
            shell: process.platform === 'win32',
            stdio: 'inherit'
        })
        child.on('error', (error) => {
            reject(new Error(`Failed to run ${[command, ...args].join(' ')}. ${error.message}`))
        })
        child.on('exit', (code, signal) => {
            if (code === 0) {
                resolve()
                return
            }
            const suffix = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
            reject(new Error(`Command failed: ${[command, ...args].join(' ')} (${suffix})`))
        })
    })
}

async function maybeInstallNodeDependencies(
    scaffold: ScaffoldResult,
    options: CliOptions,
    commandRunner: CommandRunner,
    enabled: boolean,
    onProgress?: ProgressReporter
): Promise<ScaffoldResult> {
    if (!enabled || options.skipDownload || !scaffold.pending.some((item) => item.kind === 'node-deps')) {
        return scaffold
    }

    const root = scaffold.root
    const config = scaffold.config
    const lock = scaffold.lock
    const written = new Set(scaffold.written)
    try {
        onProgress?.('Installing Node dependencies...')
        await commandRunner(root, 'pnpm', ['install'])
        onProgress?.('Node dependencies installed.')
        lock.pending = lock.pending.filter((item) => item.kind !== 'node-deps')
        if (await exists(join(root, 'pnpm-lock.yaml'))) {
            written.add('pnpm-lock.yaml')
        }
    } catch (error) {
        onProgress?.(`Node dependency install failed (${errorMessage(error)}); continuing with a pending action.`)
        lock.pending = replacePending(lock.pending, {
            kind: 'node-deps',
            reason: `pnpm install failed during project creation: ${errorMessage(error)}`,
            command: 'create-maa-project --update node-deps'
        })
    }

    await withProjectWriteLock(
        root,
        process.argv.join(' '),
        async () => {
            await writeProjectState(root, config, lock)
        },
        { clearStale: options.clearStaleLock }
    )
    written.add('maa-project.json')
    written.add('maa-project.lock.json')
    return {
        ...scaffold,
        lock,
        written: [...written],
        pending: lock.pending
    }
}

function replacePending(pending: PendingItem[], next: PendingItem): PendingItem[] {
    return [...pending.filter((item) => item.kind !== next.kind), next]
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

function defaultPending(input: {
    includeAgent: boolean
    includeDevTools: boolean
    options: CliOptions
    pythonDevCommand?: string[] | undefined
    includeOcrPending?: boolean
}): PendingItem[] {
    const pending: PendingItem[] = []
    if (input.includeDevTools) {
        pending.push({
            kind: 'node-deps',
            reason: 'Generated project dependencies are pinned in package.json but not installed by the scaffold.',
            command: 'create-maa-project --update node-deps'
        })
    }
    if (input.includeOcrPending !== false && input.options.skipDownload) {
        pending.push({
            kind: 'ocr-model',
            reason: 'OCR model download was skipped.',
            command: 'create-maa-project --update ocr-models'
        })
    } else if (input.includeOcrPending !== false) {
        pending.push({
            kind: 'ocr-model',
            reason: 'OCR model manifest source is not configured.',
            command: 'create-maa-project --update ocr-models'
        })
    }
    if (input.includeAgent) {
        pending.push(...pythonPending(input.pythonDevCommand))
    }
    return pending
}

function ocrDownloadPending(error: unknown): PendingItem {
    return {
        kind: 'ocr-model',
        reason: `OCR model download failed during project creation: ${errorMessage(error)}`,
        command: 'create-maa-project --update ocr-models'
    }
}

function pythonPending(pythonDevCommand: string[] | undefined): PendingItem[] {
    const pending: PendingItem[] = [
        {
            kind: 'python-deps',
            reason: 'Agent dependencies are managed by uv and need to be synchronized locally.',
            command: 'create-maa-project --update python-deps'
        }
    ]
    if (!pythonDevCommand) {
        pending.push({
            kind: 'python-runtime',
            reason: 'No compatible local Python command was detected for Agent development.',
            command: 'Install Python >=3.11,<3.14, then run create-maa-project --sync metadata'
        })
    }
    return pending
}

async function detectPythonDevCommand(): Promise<string[] | undefined> {
    const candidates =
        process.platform === 'win32'
            ? [
                  ['py', '-3.13'],
                  ['python'],
                  ['python3']
              ]
            : [['python3.13'], ['python3'], ['python']]
    for (const candidate of candidates) {
        const [command, ...baseArgs] = candidate
        if (!command) continue
        try {
            const result = await execFileAsync(command, [...baseArgs, '--version'], {
                timeout: 3000
            })
            const versionOutput = `${result.stdout} ${result.stderr}`
            if (!isCompatiblePythonVersion(versionOutput)) continue
            return [...candidate, 'agent/bootstrap.py']
        } catch {
            continue
        }
    }
    return undefined
}

function isCompatiblePythonVersion(output: string): boolean {
    const match = output.match(/Python\s+(\d+)\.(\d+)\.(\d+)/)
    if (!match) return false
    const major = Number(match[1])
    const minor = Number(match[2])
    return major === 3 && minor >= 11 && minor < 14
}

function assertValidVersion(version: string): void {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error(`Invalid version "${version}". Use a SemVer version such as 0.1.0.`)
    }
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
    return [...set]
}
