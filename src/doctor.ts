import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { managedFileHash, readProjectConfig, readProjectLock } from './project.js'
import { interfaceAgent, interfaceController, interfaceResourceItems } from './templates.js'
import type { ControllerKind, MaaProjectConfig, MaaProjectLock } from './types.js'
import { addV, exists, readText } from './utils.js'

export type DoctorReport = {
    ok: boolean
    lines: string[]
}

export async function runDoctor(root: string): Promise<DoctorReport> {
    const lines: string[] = []
    let ok = true
    const config = await readProjectConfig(root)
    const lock = await readProjectLock(root)

    lines.push(`[OK] Project: ${config.project.displayName} (${config.project.slug})`)
    ok = (await checkInterfaceMetadata(root, config, lines)) && ok
    ok = (await checkPackageMetadata(root, config, lines)) && ok
    ok = (await checkNodeToolingFiles(root, config, lines)) && ok
    ok = (await checkVscodeSettings(root, lines)) && ok
    ok = (await checkNodeLockfile(root, lock, lines)) && ok
    ok = (await checkPyprojectMetadata(root, config, lines)) && ok
    ok = (await checkResourceOrder(root, config, lines)) && ok
    ok = (await checkReferencedPaths(root, lines)) && ok
    ok = (await checkMaaJsonPaths(root, lines)) && ok
    ok = (await checkMaatoolsConfig(root, config, lines)) && ok
    ok = (await checkManagedFiles(root, lock, lines)) && ok

    if (lock.pending.length === 0) {
        lines.push('[OK] No pending actions.')
    } else {
        ok = false
        for (const item of lock.pending) {
            lines.push(`[WARN] Pending ${item.kind}: ${item.reason}`)
            lines.push(`       To fix: ${item.command}`)
        }
    }

    return { ok, lines }
}

async function checkInterfaceMetadata(
    root: string,
    config: MaaProjectConfig,
    lines: string[]
): Promise<boolean> {
    const interfacePath = join(root, 'interface.json')
    if (!(await exists(interfacePath))) {
        lines.push('[ERR] interface.json is missing.')
        lines.push('      To fix: restore it from backup or re-run create-maa-project --update template')
        return false
    }

    const interfaceJson = JSON.parse(await readText(interfacePath)) as {
        name?: unknown
        label?: unknown
        version?: unknown
        github?: unknown
        agent?: unknown
        controller?: unknown
    }
    let ok = true
    if (interfaceJson.name !== config.project.slug) {
        lines.push('[ERR] interface.json name differs from maa-project.json project.slug.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (interfaceJson.label !== config.project.displayName) {
        lines.push('[ERR] interface.json label differs from maa-project.json project.displayName.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (interfaceJson.version !== addV(config.project.version)) {
        lines.push('[ERR] interface.json version differs from maa-project.json project.version.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (interfaceJson.agent !== undefined && !Array.isArray(interfaceJson.agent)) {
        lines.push('[ERR] interface.json agent must be an array.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (JSON.stringify(interfaceJson.agent) !== JSON.stringify(expectedInterfaceAgent(config))) {
        lines.push('[ERR] interface.json agent differs from maa-project.json python config.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (interfaceJson.github !== config.project.github) {
        lines.push('[ERR] interface.json github differs from maa-project.json project.github.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (
        JSON.stringify(interfaceJson.controller ?? []) !==
        JSON.stringify(interfaceController(projectControllerKind(config)))
    ) {
        lines.push('[ERR] interface.json controller differs from maa-project.json controller.kind.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (ok) lines.push('[OK] Interface metadata matches project config.')
    return ok
}

function projectControllerKind(config: MaaProjectConfig): ControllerKind {
    const raw = (config as MaaProjectConfig & { controller?: { kind?: unknown } }).controller?.kind
    return raw === 'ADB' || raw === 'Win32' || raw === 'None' ? raw : 'ADB'
}

function expectedInterfaceAgent(config: MaaProjectConfig): ReturnType<typeof interfaceAgent>[] | undefined {
    return config.python ? [interfaceAgent(config.project.slug, config.python.devCommand)] : undefined
}

async function checkPackageMetadata(
    root: string,
    config: MaaProjectConfig,
    lines: string[]
): Promise<boolean> {
    const packagePath = join(root, 'package.json')
    if (!(await exists(packagePath))) {
        lines.push('[ERR] package.json is missing.')
        lines.push('      To fix: restore it from backup or run create-maa-project --update template')
        return false
    }

    const packageJson = JSON.parse(await readText(packagePath)) as {
        name?: unknown
        version?: unknown
        license?: unknown
        packageManager?: unknown
        engines?: { node?: unknown }
        devDependencies?: Record<string, unknown>
        scripts?: Record<string, unknown>
    }
    const expectedLicense = config.license.spdx === 'None' ? 'UNLICENSED' : config.license.spdx
    let ok = true
    if (packageJson.name !== config.project.slug) {
        lines.push('[ERR] package.json name differs from maa-project.json project.slug.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (packageJson.version !== config.project.version) {
        lines.push('[ERR] package.json version differs from maa-project.json project.version.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (packageJson.license !== expectedLicense) {
        lines.push('[ERR] package.json license differs from maa-project.json license.spdx.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (packageJson.packageManager !== 'pnpm@11.5.1') {
        lines.push('[ERR] package.json packageManager must be pnpm@11.5.1.')
        lines.push('      To fix: create-maa-project --update template')
        ok = false
    }
    if (packageJson.engines?.node !== '>=24') {
        lines.push('[ERR] package.json engines.node must be >=24.')
        lines.push('      To fix: create-maa-project --update template')
        ok = false
    }
    for (const [name, version] of Object.entries(expectedDevDependencies())) {
        if (packageJson.devDependencies?.[name] !== version) {
            const label =
                name === '@nekosu/maa-tools'
                    ? '@nekosu/maa-tools'
                    : `devDependencies.${name}`
            lines.push(`[ERR] package.json ${label} must be pinned to ${version}.`)
            lines.push('      To fix: create-maa-project --update template')
            ok = false
        }
    }
    for (const [name, command] of Object.entries(expectedPackageScripts(config))) {
        if (packageJson.scripts?.[name] !== command) {
            const message =
                name === 'check:maa'
                    ? 'package.json scripts.check:maa must use local pnpm exec maa-tools check.'
                    : `package.json scripts.${name} must be ${command}.`
            lines.push(`[ERR] ${message}`)
            lines.push('      To fix: create-maa-project --update template')
            ok = false
        }
    }
    if (ok) lines.push('[OK] Package metadata matches project config.')
    return ok
}

async function checkNodeLockfile(
    root: string,
    lock: MaaProjectLock,
    lines: string[]
): Promise<boolean> {
    if (lock.pending.some((item) => item.kind === 'node-deps')) return true
    const packagePath = join(root, 'package.json')
    if (!(await exists(packagePath))) return true
    const packageJson = JSON.parse(await readText(packagePath)) as { packageManager?: unknown }
    if (typeof packageJson.packageManager !== 'string' || !packageJson.packageManager.startsWith('pnpm@')) {
        return true
    }
    if (await exists(join(root, 'pnpm-lock.yaml'))) {
        lines.push('[OK] pnpm lockfile is present.')
        return true
    }
    lines.push('[ERR] pnpm-lock.yaml is missing.')
    lines.push('      To fix: pnpm install')
    return false
}

async function checkNodeToolingFiles(
    root: string,
    config: MaaProjectConfig,
    lines: string[]
): Promise<boolean> {
    let ok = true
    const nodeVersionPath = join(root, '.node-version')
    if (!(await exists(nodeVersionPath))) {
        lines.push('[ERR] .node-version is missing.')
        lines.push('      To fix: restore it from backup or run create-maa-project --update template')
        ok = false
    } else if ((await readText(nodeVersionPath)).trim() !== '24') {
        lines.push('[ERR] .node-version must pin Node 24.')
        lines.push('      To fix: create-maa-project --update template')
        ok = false
    }

    const workflows = ['.github/workflows/check.yml', '.github/workflows/release.yml']
    if (config.addons.schemaSync) workflows.push('.github/workflows/schema-sync.yml')
    for (const workflow of workflows) {
        const workflowPath = join(root, workflow)
        if (!(await exists(workflowPath))) {
            lines.push(`[ERR] ${workflow} is missing.`)
            lines.push('      To fix: restore it from backup or run create-maa-project --update template')
            ok = false
            continue
        }
        if (!workflowPinsNode24(await readText(workflowPath))) {
            lines.push(`[ERR] ${workflow} must use Node 24 in actions/setup-node.`)
            lines.push('      To fix: create-maa-project --update template')
            ok = false
        }
    }

    if (ok) lines.push('[OK] Node tooling files pin Node 24.')
    return ok
}

async function checkVscodeSettings(root: string, lines: string[]): Promise<boolean> {
    const settingsPath = join(root, '.vscode/settings.json')
    if (!(await exists(settingsPath))) {
        lines.push('[ERR] .vscode/settings.json is missing.')
        lines.push('      To fix: restore it from backup or run create-maa-project --update template')
        return false
    }

    const settings = JSON.parse(await readText(settingsPath)) as Record<string, unknown>
    let ok = true
    if (settings['editor.formatOnSave'] !== true) {
        lines.push('[ERR] .vscode/settings.json editor.formatOnSave must be true.')
        lines.push('      To fix: create-maa-project --update template')
        ok = false
    }
    if (settings['files.eol'] !== '\n') {
        lines.push('[ERR] .vscode/settings.json files.eol must be LF.')
        lines.push('      To fix: create-maa-project --update template')
        ok = false
    }
    if (!hasJsoncFileAssociations(settings['files.associations'])) {
        lines.push('[ERR] .vscode/settings.json files.associations must map *.json and *.jsonc to jsonc.')
        lines.push('      To fix: create-maa-project --update template')
        ok = false
    }
    for (const language of ['[json]', '[jsonc]']) {
        if (editorDefaultFormatter(settings[language]) !== 'esbenp.prettier-vscode') {
            lines.push(
                `[ERR] .vscode/settings.json ${language} editor.defaultFormatter must be esbenp.prettier-vscode.`
            )
            lines.push('      To fix: create-maa-project --update template')
            ok = false
        }
    }
    if (!hasInterfaceJsonSchema(settings['json.schemas'])) {
        lines.push(
            '[ERR] .vscode/settings.json json.schemas must map /interface.json to ./tools/schema/interface.schema.json.'
        )
        lines.push('      To fix: create-maa-project --update template')
        ok = false
    }
    if (ok) lines.push('[OK] VS Code settings configure Prettier and interface schema.')
    return ok
}

async function checkPyprojectMetadata(
    root: string,
    config: MaaProjectConfig,
    lines: string[]
): Promise<boolean> {
    if (!config.python) return true

    const pyprojectPath = join(root, 'pyproject.toml')
    if (!(await exists(pyprojectPath))) return true

    const metadata = parseTomlProjectMetadata(await readText(pyprojectPath))
    let ok = true
    if (metadata.name !== config.project.slug) {
        lines.push('[ERR] pyproject.toml project.name differs from maa-project.json project.slug.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (metadata.version !== config.project.version) {
        lines.push('[ERR] pyproject.toml project.version differs from maa-project.json project.version.')
        lines.push('      To fix: create-maa-project --sync metadata')
        ok = false
    }
    if (ok) lines.push('[OK] Python project metadata matches project config.')
    return ok
}

async function checkResourceOrder(
    root: string,
    config: MaaProjectConfig,
    lines: string[]
): Promise<boolean> {
    const first = config.resources[0]
    if (!first || first.path !== 'resource/base') {
        lines.push('[ERR] resource/base must be the first resource pack.')
        lines.push('      To fix: edit maa-project.json resources order, then run create-maa-project --sync metadata')
        return false
    }
    for (const pack of config.resources) {
        if (pack.path.includes('\\')) {
            lines.push(`[ERR] Resource pack path uses backslashes: ${pack.path}`)
            lines.push('      To fix: use forward slashes in maa-project.json')
            return false
        }
        if (!(await exists(join(root, pack.path)))) {
            lines.push(`[ERR] Resource pack path is missing: ${pack.path}`)
            lines.push(`      To fix: create the directory or remove ${pack.slug} from maa-project.json`)
            return false
        }
    }
    const interfacePath = join(root, 'interface.json')
    if (await exists(interfacePath)) {
        const interfaceJson = JSON.parse(await readText(interfacePath)) as { resource?: unknown }
        const actual = Array.isArray(interfaceJson.resource) ? interfaceJson.resource : []
        const expected = interfaceResourceItems(config.resources)
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            lines.push('[ERR] interface.json resource order differs from maa-project.json resources.')
            lines.push('      To fix: create-maa-project --sync metadata')
            return false
        }
    }
    lines.push('[OK] Resource packs are ordered and present.')
    return true
}

async function checkReferencedPaths(root: string, lines: string[]): Promise<boolean> {
    const interfacePath = join(root, 'interface.json')
    if (!(await exists(interfacePath))) return false

    const interfaceJson = JSON.parse(await readText(interfacePath)) as {
        import?: unknown
        resource?: unknown
    }
    let ok = true
    const references = [
        ...interfaceResourcePaths(interfaceJson.resource).map((path) => ({ kind: 'resource', path })),
        ...arrayOfStrings(interfaceJson.import).map((path) => ({ kind: 'import', path }))
    ]
    for (const reference of references) {
        if (reference.path.includes('\\')) {
            lines.push(`[ERR] interface.json ${reference.kind} path uses backslashes: ${reference.path}`)
            lines.push('      To fix: create-maa-project --sync metadata')
            ok = false
            continue
        }
        if (!(await exists(join(root, stripDotSlash(reference.path))))) {
            lines.push(`[ERR] interface.json ${reference.kind} path is missing: ${reference.path}`)
            lines.push('      To fix: restore the path or run create-maa-project --sync metadata')
            ok = false
        }
    }
    if (ok) lines.push('[OK] Interface referenced paths are present.')
    return ok
}

async function checkMaaJsonPaths(root: string, lines: string[]): Promise<boolean> {
    let ok = true
    for (const path of await listJsonFiles(root, ['interface.json', 'tasks', 'resource'])) {
        const content = await readText(join(root, path))
        if (!content.includes('\\')) continue
        lines.push(`[ERR] MaaFW JSON paths must use forward slashes: ${path}`)
        lines.push(`      To fix: replace backslashes with / in ${path}`)
        ok = false
    }
    if (ok) lines.push('[OK] MaaFW JSON paths use forward slashes.')
    return ok
}

async function checkMaatoolsConfig(
    root: string,
    config: MaaProjectConfig,
    lines: string[]
): Promise<boolean> {
    const configPath = join(root, 'maatools.config.mts')
    if (!(await exists(configPath))) {
        lines.push('[ERR] maatools.config.mts is missing.')
        lines.push('      To fix: create-maa-project --sync metadata')
        return false
    }
    const content = await readText(configPath)
    const expected = config.resources.map((pack) => `./${pack.path}`)
    const actual = parseMaatoolsResourceArray(content)
    if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
        lines.push('[ERR] maatools.config.mts resource order differs from maa-project.json resources.')
        lines.push('      To fix: create-maa-project --sync metadata')
        return false
    }
    lines.push('[OK] Maa tools resource order matches project config.')
    return true
}

async function checkManagedFiles(
    root: string,
    lock: MaaProjectLock,
    lines: string[]
): Promise<boolean> {
    let ok = true
    const entries = Object.entries(lock.managedFiles)
    for (const [path, state] of entries) {
        const fullPath = join(root, path)
        if (!(await exists(fullPath))) {
            lines.push(`[ERR] Managed file is missing: ${path}`)
            lines.push('      To fix: restore it from backup or run create-maa-project --update template')
            ok = false
            continue
        }
        const currentHash = managedFileHash(path, await readManagedFileForDoctor(fullPath, path))
        if (currentHash !== state.hash) {
            lines.push(`[WARN] Managed file changed since last accepted baseline: ${path}`)
            lines.push(`       To accept: create-maa-project --accept-changes ${path}`)
            if (state.acceptedAt) {
                lines.push('       Future template updates may conflict with this accepted local baseline.')
            }
            ok = false
        } else if (state.acceptedAt) {
            lines.push(`[INFO] Managed file has accepted local changes: ${path}`)
            lines.push('       Future template updates may conflict with this file.')
        }
    }
    if (ok) lines.push(`[OK] Managed files match baselines (${entries.length}).`)
    return ok
}

async function readManagedFileForDoctor(fullPath: string, managedPath: string): Promise<string | Buffer> {
    return managedPath.endsWith('.onnx') ? readFile(fullPath) : readText(fullPath)
}

async function listJsonFiles(root: string, paths: string[]): Promise<string[]> {
    const files: string[] = []
    for (const path of paths) {
        const fullPath = join(root, path)
        if (!(await exists(fullPath))) continue
        const entries = await safeReadDirectory(fullPath)
        if (!entries) {
            if (path.endsWith('.json')) files.push(path)
            continue
        }
        for (const entry of entries) {
            files.push(...(await listJsonFiles(root, [`${path}/${entry}`])))
        }
    }
    return files
}

async function safeReadDirectory(path: string): Promise<string[] | undefined> {
    try {
        const entries = await readdir(path, { withFileTypes: true })
        return entries.map((entry) => entry.name)
    } catch {
        return undefined
    }
}

function arrayOfStrings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function interfaceResourcePaths(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => (isRecord(item) ? arrayOfStrings(item.path) : []))
}

function stripDotSlash(path: string): string {
    return path.startsWith('./') ? path.slice(2) : path
}

function workflowPinsNode24(content: string): boolean {
    return /node-version:\s*['"]?24['"]?/.test(content)
}

function editorDefaultFormatter(value: unknown): string | undefined {
    if (!isRecord(value)) return undefined
    const formatter = value['editor.defaultFormatter']
    return typeof formatter === 'string' ? formatter : undefined
}

function hasInterfaceJsonSchema(value: unknown): boolean {
    if (!Array.isArray(value)) return false
    return value.some((item) => {
        if (!isRecord(item) || item.url !== './tools/schema/interface.schema.json') return false
        const fileMatch = item.fileMatch
        return Array.isArray(fileMatch) && fileMatch.includes('/interface.json')
    })
}

function hasJsoncFileAssociations(value: unknown): boolean {
    return isRecord(value) && value['*.json'] === 'jsonc' && value['*.jsonc'] === 'jsonc'
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectedDevDependencies(): Record<string, string> {
    return {
        '@nekosu/maa-tools': '1.0.24',
        '@nekosu/prettier-plugin-maafw-sort': '1.0.5',
        prettier: '3.8.4',
        'prettier-plugin-multiline-arrays': '4.1.9'
    }
}

function expectedPackageScripts(config: MaaProjectConfig): Record<string, string> {
    const scripts: Record<string, string> = {
        format: 'prettier --write .',
        'format:check': 'prettier --check .',
        lint: 'node tools/check-project.mjs',
        'check:schema': 'node tools/validate-schema.mjs',
        'check:maa': 'pnpm exec maa-tools check',
        check: 'pnpm format:check && pnpm check:schema && pnpm check:maa && pnpm lint',
        'release:dry-run': 'node tools/build-release.mjs --dry-run',
        'sync:runtime': 'node tools/sync-runtime.mjs'
    }
    if (config.addons.schemaSync) {
        scripts['sync:schema'] = 'node tools/sync-schema.mjs'
    }
    if (config.python) {
        scripts['format:py'] = 'uv run --frozen ruff format .'
        scripts['lint:py'] = 'uv run --frozen ruff check .'
        scripts['typecheck:py'] = 'uv run --frozen pyright'
        scripts['check:py'] = 'pnpm lint:py && pnpm typecheck:py'
    }
    return scripts
}

function parseMaatoolsResourceArray(content: string): string[] | undefined {
    const match = content.match(/resource\s*:\s*(\[[^\]]*\])/)
    if (!match?.[1]) return undefined
    try {
        const parsed = JSON.parse(match[1]) as unknown
        return arrayOfStrings(parsed)
    } catch {
        return undefined
    }
}

function parseTomlProjectMetadata(content: string): {
    name: string | undefined
    version: string | undefined
} {
    const section = tomlProjectSection(content)
    return {
        name: parseTomlStringField(section, 'name'),
        version: parseTomlStringField(section, 'version')
    }
}

function tomlProjectSection(content: string): string {
    const section: string[] = []
    let inside = false
    for (const line of content.split(/\r?\n/)) {
        if (/^\s*\[project\]\s*$/.test(line)) {
            inside = true
            continue
        }
        if (inside && /^\s*\[[^\]]+\]\s*$/.test(line)) break
        if (inside) section.push(line)
    }
    return section.join('\n')
}

function parseTomlStringField(section: string, key: 'name' | 'version'): string | undefined {
    const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm'))
    return match?.[1]
}
