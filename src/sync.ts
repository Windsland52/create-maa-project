import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONFIG_FILE,
  migrateStoredProjectConfig,
  readProjectConfig,
  withProjectWriteLock,
  writeGeneratedFiles,
  writeProjectState,
} from './project.js'
import type { ProjectWriteOperation } from './project.js'
import {
  interfaceAgent,
  interfaceController,
  interfaceResourceItems,
  licenseText,
  maatoolsConfigFile,
} from './templates.js'
import type { CliOptions, ControllerKind, LicenseKind, ManagedFileInput, NetworkMode, ScaffoldResult } from './types.js'
import { normalizeControllerKind, projectControllerKinds } from './controllers.js'
import { enabledResourcePacks, hasDevTools } from './features.js'
import { addV, exists, prettyJson, readText, stableJson, stripV, throwIfAborted, writeFileAtomic } from './utils.js'
import { assertValidSemVer } from './semver.js'

const syncOperation = Symbol('syncOperation')

type ProjectConfig = Awaited<ReturnType<typeof readProjectConfig>>

type SyncEnvironment = {
  writeFiles?: typeof writeGeneratedFiles
  root?: string
  operationCommand?: string
  signal?: AbortSignal
  [syncOperation]?: ProjectWriteOperation
}

export async function syncProject(options: CliOptions, environment: SyncEnvironment = {}): Promise<ScaffoldResult> {
  throwIfAborted(environment.signal)
  const root = environment.root ?? process.cwd()
  const sync = options.sync
  if (!sync) throw new Error('Missing --sync target')
  if (sync === 'config') {
    if (options.syncValue !== undefined) throw new Error('--sync config does not accept a value.')
    const result = await migrateStoredProjectConfig(
      root,
      options.clearStaleLock,
      environment.operationCommand,
      environment.signal,
    )
    throwIfAborted(environment.signal)
    return result
  }
  if (!environment[syncOperation]) {
    return withProjectWriteLock(
      root,
      environment.operationCommand ?? process.argv.join(' '),
      (operation) => syncProject(options, { ...environment, [syncOperation]: operation }),
      { clearStale: options.clearStaleLock },
    )
  }
  throwIfAborted(environment.signal)
  const config = await readProjectConfig(root)

  const interfaceJson = JSON.parse(await readText(join(root, 'interface.json'))) as Record<string, unknown>
  const packagePath = join(root, 'package.json')
  const packageJson = (await exists(packagePath))
    ? (JSON.parse(await readText(packagePath)) as Record<string, unknown>)
    : undefined
  const files: ManagedFileInput[] = []
  const removeAfterWrite: string[] = []

  switch (sync) {
    case 'metadata':
      if (options.syncValue !== undefined) throw new Error('--sync metadata does not accept a value.')
      break
    case 'display-name': {
      config.project.displayName = requiredNonBlank(
        options.displayName ?? options.syncValue,
        '--sync display-name requires --name <display-name>',
      )
      break
    }
    case 'version': {
      const version = stripV(options.version ?? options.syncValue ?? '')
      if (!version) throw new Error('--sync version requires --version <semver>')
      assertValidSemVer(version)
      config.project.version = version
      interfaceJson.version = addV(version)
      if (packageJson) packageJson.version = version
      break
    }
    case 'license': {
      const license =
        options.license ??
        requiredChoice<LicenseKind>(
          options.syncValue,
          ['AGPL-3.0-or-later', 'MIT', 'None'],
          '--sync license requires a value such as MIT.',
          'license',
        )
      config.license.spdx = license
      if (packageJson) packageJson.license = license === 'None' ? 'UNLICENSED' : license
      break
    }
    case 'network': {
      const network =
        options.network ??
        requiredChoice<NetworkMode>(
          options.syncValue,
          ['auto', 'official'],
          '--sync network requires a value such as official.',
          'network mode',
        )
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

  applyInterfaceMetadata(interfaceJson, config, await exists(join(root, 'logo.ico')))
  if (packageJson) applyPackageMetadata(packageJson, config)
  const pyproject = await syncedPyproject(root, config)
  throwIfAborted(environment.signal)

  files.push(
    maatoolsConfigFile(
      enabledResourcePacks(config).map((pack) => `./${pack.path}`),
      config.python !== undefined,
    ),
  )
  files.push({ path: CONFIG_FILE, content: stableJson(config), managed: false })
  // interface.json is intentionally unmanaged: projects may carry a hand-tuned
  // controller/resource layout (e.g. multi-server packs) that the template-
  // generated content would clobber. Only write it on first creation; once it
  // exists, leave it untouched and let doctor drift checks surface any
  // metadata divergence instead of overwriting it.
  if (config.project.interfaceUnmanaged && (await exists(join(root, 'interface.json')))) {
    // interface.json is unmanaged: projects may carry a hand-tuned
    // controller/resource layout (e.g. multi-server packs) that the
    // template-generated content would clobber. Leave it untouched.
  } else {
    files.push({ path: 'interface.json', content: prettyJson(interfaceJson), managed: false })
  }
  if (packageJson && hasDevTools(config)) {
    files.splice(2, 0, { path: 'package.json', content: stableJson(packageJson), managed: false })
  }
  if (pyproject) files.push(pyproject)
  if (sync === 'license') {
    const generatedLicense = licenseText({
      license: config.license.spdx,
      displayName: config.project.displayName,
    })
    files.push({
      path: 'LICENSE',
      content: generatedLicense ?? '',
      managed: false,
    })
    if (generatedLicense === undefined) removeAfterWrite.push('LICENSE')
  }

  const result =
    sync === 'license'
      ? await applySyncFileTransaction(root, files, removeAfterWrite, environment.writeFiles ?? writeGeneratedFiles)
      : await writeGeneratedFiles(root, files, {
          force: true,
          backup: true,
          overwriteUnmanaged: true,
        })
  throwIfAborted(environment.signal)
  if (sync !== 'license') await writeProjectState(root, config)
  throwIfAborted(environment.signal)
  return {
    root,
    config,
    written: result.written,
    skipped: result.skipped,
    pending: [],
    backupId: environment[syncOperation].backupId,
  }
}

type FileSnapshot = {
  path: string
  content: Buffer | undefined
}

async function applySyncFileTransaction(
  root: string,
  files: ManagedFileInput[],
  removeAfterWrite: string[],
  writeFiles: typeof writeGeneratedFiles,
): Promise<{ written: string[]; skipped: string[] }> {
  const paths = [
    ...new Set([
      ...files.map((file) => file.path),
      ...removeAfterWrite,
    ]),
  ]
  const snapshots = await Promise.all(
    paths.map(async (path): Promise<FileSnapshot> => {
      const fullPath = join(root, path)
      return {
        path,
        content: (await exists(fullPath)) ? await readFile(fullPath) : undefined,
      }
    }),
  )

  try {
    const result = await writeFiles(root, files, {
      force: true,
      backup: true,
      overwriteUnmanaged: true,
    })
    for (const path of removeAfterWrite) {
      await rm(join(root, path), { force: true })
    }
    return result
  } catch (error) {
    try {
      await Promise.all(
        snapshots.map(async (snapshot) => {
          const fullPath = join(root, snapshot.path)
          if (snapshot.content === undefined) {
            await rm(fullPath, { force: true, recursive: true })
          } else {
            await writeFileAtomic(fullPath, snapshot.content)
          }
        }),
      )
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Sync failed and the original project files could not be restored.',
      )
    }
    throw error
  }
}

function requiredNonBlank(value: string | undefined, message: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(message)
  return normalized
}

function requiredChoice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  missingMessage: string,
  label: string,
): T {
  const normalized = requiredNonBlank(value, missingMessage)
  if (!allowed.includes(normalized as T)) {
    throw new Error(`Invalid ${label} "${normalized}". Expected one of: ${allowed.join(', ')}.`)
  }
  return normalized as T
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

function applyPackageMetadata(packageJson: Record<string, unknown>, config: ProjectConfig): void {
  packageJson.name = config.project.slug
  packageJson.version = config.project.version
  packageJson.license = config.license.spdx === 'None' ? 'UNLICENSED' : config.license.spdx
}

/**
 * Controller IDs the CLI itself used to write. An entry carrying one is the same controller as the
 * derived entry that replaced it, so it is renamed in place instead of being kept as a duplicate.
 */
const LEGACY_CONTROLLER_IDS: Record<string, string> = {
  Android: 'Adb',
  WlRoots: 'Linux',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function entriesOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord).map((entry) => ({ ...entry })) : []
}

function canonicalControllerId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return LEGACY_CONTROLLER_IDS[value] ?? value
}

function controllerKindOf(entry: Record<string, unknown>): ControllerKind | undefined {
  return typeof entry.type === 'string' ? normalizeControllerKind(entry.type) : undefined
}

/** An entry the config cannot express may still carry a `type` the synced schema rejects. */
function withRepairedControllerType(entry: Record<string, unknown>): Record<string, unknown> {
  const kind = controllerKindOf(entry)
  return kind === undefined ? entry : { ...entry, type: kind }
}

/**
 * `interface.json` is hand-tuned: a project may carry controller fields the CLI never writes
 * (`attach_resource_path`, `icon`, `option`, a per-type block, a label of its own, …) or a
 * controller the config cannot express, such as a second Adb client. Each configured kind therefore
 * repairs the entry already serving it: the CLI's own entry, matched by ID including the IDs it used
 * to write, gets its ID and enum refreshed, while an entry that merely serves that kind only gets its
 * enum repaired and keeps its identity. A kind nothing serves gets the derived default, and every
 * other entry is kept, so syncing metadata repairs drift without discarding what the project wrote.
 */
function syncedControllers(existing: unknown, config: ProjectConfig): Array<Record<string, unknown>> {
  const entries = entriesOf(existing)
  const claimed = new Set<Record<string, unknown>>()
  const merged: Array<Record<string, unknown>> = interfaceController(projectControllerKinds(config)).map((target) => {
    const own = entries.find((entry) => !claimed.has(entry) && canonicalControllerId(entry.name) === target.name)
    if (own !== undefined) {
      claimed.add(own)
      return { ...own, name: target.name, type: target.type }
    }
    const kind = normalizeControllerKind(target.type)
    const serving = entries.find((entry) => !claimed.has(entry) && controllerKindOf(entry) === kind)
    if (serving !== undefined) {
      claimed.add(serving)
      return { ...serving, type: target.type }
    }
    return { ...target }
  })
  for (const entry of entries) {
    if (!claimed.has(entry)) merged.push(withRepairedControllerType(entry))
  }
  return merged
}

/**
 * Packs work like controllers: the config owns the packs it knows, so it refreshes them in place and
 * drops the ones it turned off, while a pack it has never heard of belongs to someone else and stays.
 */
function syncedResources(existing: unknown, config: ProjectConfig): Array<Record<string, unknown>> {
  const disabled = new Set(config.resources.filter((pack) => !pack.enabled).map((pack) => pack.slug))
  const available = entriesOf(existing).filter((entry) => !(typeof entry.name === 'string' && disabled.has(entry.name)))
  const claimed = new Set<Record<string, unknown>>()
  const merged: Array<Record<string, unknown>> = interfaceResourceItems(enabledResourcePacks(config)).map((target) => {
    const current = available.find((entry) => !claimed.has(entry) && entry.name === target.name)
    if (current === undefined) return { ...target }
    claimed.add(current)
    return { ...current, label: target.label, path: target.path }
  })
  for (const entry of available) {
    if (!claimed.has(entry)) merged.push(entry)
  }
  return merged
}

function applyInterfaceMetadata(
  interfaceJson: Record<string, unknown>,
  config: ProjectConfig,
  hasDefaultIcon: boolean,
): void {
  interfaceJson.name = config.project.slug
  interfaceJson.label = config.project.displayName
  interfaceJson.version = addV(config.project.version)
  if (hasDefaultIcon) {
    if (interfaceJson.icon === undefined || interfaceJson.icon === 'logo.ico') {
      interfaceJson.icon = 'logo.ico'
    }
  } else if (interfaceJson.icon === 'logo.ico') {
    delete interfaceJson.icon
  }
  interfaceJson.controller = syncedControllers(interfaceJson.controller, config)
  interfaceJson.resource = syncedResources(interfaceJson.resource, config)
  // The config is the source when it carries a link. With none, a hand-written one is left alone;
  // doctor reports that divergence as INFO rather than deleting a value it does not manage.
  if (config.project.github) interfaceJson.github = config.project.github
  if (config.python) {
    const derived = interfaceAgent(config.python.devCommand)
    const [
      current,
      ...rest
    ] = entriesOf(interfaceJson.agent)
    const agent = current === undefined ? { ...derived } : { ...current, ...derived }
    // `child_args` is generated only for a command with arguments, so a refreshed agent has to drop
    // a stale list instead of inheriting the one it had.
    if (current !== undefined && derived.child_args === undefined) delete agent.child_args
    interfaceJson.agent = [
      agent,
      ...rest,
    ]
  }
}

async function syncedPyproject(
  root: string,
  config: Awaited<ReturnType<typeof readProjectConfig>>,
): Promise<ManagedFileInput | undefined> {
  if (!config.python) return undefined
  const path = 'pyproject.toml'
  const fullPath = join(root, path)
  if (!(await exists(fullPath))) return undefined
  const content = await readText(fullPath)
  return {
    path,
    content: syncTomlProjectMetadata(content, config.project.slug, config.project.version),
    managed: true,
  }
}

function syncTomlProjectMetadata(content: string, name: string, version: string): string {
  return syncTomlProjectField(syncTomlProjectField(content, 'name', name), 'version', version)
}

function syncTomlProjectField(content: string, key: 'name' | 'version', value: string): string {
  const projectStart = content.search(/^\[project\]\s*$/m)
  if (projectStart < 0) return content
  const afterProject = content.slice(projectStart + '[project]'.length)
  const nextSection = afterProject.search(/^\[[^\]]+\]\s*$/m)
  const sectionEnd = nextSection < 0 ? content.length : projectStart + '[project]'.length + nextSection
  const before = content.slice(0, projectStart)
  const section = content.slice(projectStart, sectionEnd)
  const after = content.slice(sectionEnd)
  const pattern = new RegExp(`^${key}\\s*=\\s*"[^"]*"\\s*$`, 'm')
  if (!pattern.test(section)) return content
  return `${before}${section.replace(pattern, `${key} = "${value}"`)}${after}`
}
