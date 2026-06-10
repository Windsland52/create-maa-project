import { join } from 'node:path'
import { CONFIG_FILE, readProjectConfig, readProjectLock, withProjectWriteLock, writeGeneratedFiles, writeProjectState } from './project.js'
import { interfaceController, interfaceResourceItems, maatoolsConfigFile } from './templates.js'
import type { CliOptions, ControllerKind, MaaProjectConfig, ManagedFileInput, ScaffoldResult } from './types.js'
import { addV, nowIso, prettyJson, readText, stableJson, stripV } from './utils.js'

const CLI_VERSION = '0.1.0'

export async function syncProject(options: CliOptions): Promise<ScaffoldResult> {
    const root = process.cwd()
    const config = await readProjectConfig(root)
    const lock = await readProjectLock(root)
    const sync = options.sync
    if (!sync) throw new Error('Missing --sync target')
    normalizeConfig(config)

    const interfaceJson = JSON.parse(await readText(join(root, 'interface.json'))) as Record<string, unknown>
    const packageJson = JSON.parse(await readText(join(root, 'package.json'))) as Record<string, unknown>
    const files: ManagedFileInput[] = []

    switch (sync) {
        case 'metadata':
            break
        case 'display-name': {
            config.project.displayName = requiredNonBlank(
                options.displayName ?? options.syncValue,
                '--sync display-name requires --name <display-name>'
            )
            break
        }
        case 'version': {
            const version = stripV(options.version ?? options.syncValue ?? '')
            if (!version) throw new Error('--sync version requires --version <semver>')
            assertSemver(version)
            config.project.version = version
            interfaceJson.version = addV(version)
            packageJson.version = version
            break
        }
        case 'license': {
            const license = options.license
            if (!license) throw new Error('--sync license requires --license <spdx>')
            config.license.spdx = license
            packageJson.license = license === 'None' ? 'UNLICENSED' : license
            break
        }
        case 'network': {
            const network = options.network
            if (!network) throw new Error('--sync network requires --network <mode>')
            config.network.mode = network
            break
        }
        case 'github-url': {
            const url = normalizeGithubRepoUrl(options.syncValue)
            config.project.github = url
            interfaceJson.github = url
            break
        }
        default:
            throw new Error(`Unsupported sync target: ${sync}`)
    }

    applyInterfaceMetadata(interfaceJson, config)
    applyPackageMetadata(packageJson, config)

    files.push(
        { path: 'interface.json', content: prettyJson(interfaceJson), managed: false },
        maatoolsConfigFile(config.resources.map((pack) => `./${pack.path}`)),
        { path: 'package.json', content: stableJson(packageJson), managed: false },
        { path: CONFIG_FILE, content: stableJson(config), managed: false }
    )

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

function recordCreatedFiles(
    lock: Awaited<ReturnType<typeof readProjectLock>>,
    files: ManagedFileInput[],
    written: string[]
): void {
    for (const file of files) {
        if (!file.managed && written.includes(file.path) && !lock.createdFiles[file.path]) {
            lock.createdFiles[file.path] = {
                createdAt: nowIso(),
                managed: false
            }
        }
    }
}

function assertSemver(version: string): void {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error(`Invalid version "${version}". Use a SemVer version such as 0.1.0.`)
    }
}

function requiredNonBlank(value: string | undefined, message: string): string {
    const normalized = value?.trim()
    if (!normalized) throw new Error(message)
    return normalized
}

function normalizeGithubRepoUrl(value: string | undefined): string {
    const raw = requiredNonBlank(value, '--sync github-url requires a URL')
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        throw new Error(`Invalid GitHub URL "${raw}". Use an HTTPS GitHub repository URL.`)
    }
    const host = url.hostname.toLowerCase()
    const pathParts = url.pathname.split('/').filter((part) => part.length > 0)
    if (
        url.protocol !== 'https:' ||
        host !== 'github.com' ||
        pathParts.length !== 2 ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        pathParts.some((part) => part === '.' || part === '..')
    ) {
        throw new Error(`Invalid GitHub URL "${raw}". Use an HTTPS GitHub repository URL.`)
    }
    return `https://github.com/${pathParts[0]}/${pathParts[1]}`
}

function applyPackageMetadata(
    packageJson: Record<string, unknown>,
    config: Awaited<ReturnType<typeof readProjectConfig>>
): void {
    packageJson.name = config.project.slug
    packageJson.version = config.project.version
    packageJson.license = config.license.spdx === 'None' ? 'UNLICENSED' : config.license.spdx
}

function applyInterfaceMetadata(
    interfaceJson: Record<string, unknown>,
    config: Awaited<ReturnType<typeof readProjectConfig>>
): void {
    interfaceJson.name = config.project.slug
    interfaceJson.label = config.project.displayName
    interfaceJson.version = addV(config.project.version)
    interfaceJson.controller = interfaceController(config.controller.kind)
    interfaceJson.resource = interfaceResourceItems(config.resources)
    if (config.project.github) {
        interfaceJson.github = config.project.github
    } else {
        delete interfaceJson.github
    }
    delete interfaceJson.agent
}

function normalizeConfig(config: MaaProjectConfig): void {
    const configWithOptionalController = config as MaaProjectConfig & {
        controller?: { kind?: ControllerKind }
    }
    if (!configWithOptionalController.controller?.kind) {
        configWithOptionalController.controller = { kind: 'ADB' }
    }
}
