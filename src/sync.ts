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
import type { CliOptions, LicenseKind, ManagedFileInput, NetworkMode, ScaffoldResult } from './types.js'
import { projectControllerKinds } from './controllers.js'
import { enabledResourcePacks, hasDevTools } from './features.js'
import { addV, exists, prettyJson, readText, stableJson, stripV, writeFileAtomic } from './utils.js'
import { assertValidSemVer } from './semver.js'

const syncOperation = Symbol('syncOperation')

type SyncEnvironment = {
  writeFiles?: typeof writeGeneratedFiles
  root?: string
  operationCommand?: string
  [syncOperation]?: ProjectWriteOperation
}

export async function syncProject(options: CliOptions, environment: SyncEnvironment = {}): Promise<ScaffoldResult> {
  const root = environment.root ?? process.cwd()
  const sync = options.sync
  if (!sync) throw new Error('Missing --sync target')
  if (sync === 'config') {
    if (options.syncValue !== undefined) throw new Error('--sync config does not accept a value.')
    return migrateStoredProjectConfig(root, options.clearStaleLock, environment.operationCommand)
  }
  if (!environment[syncOperation]) {
    return withProjectWriteLock(
      root,
      environment.operationCommand ?? process.argv.join(' '),
      (operation) => syncProject(options, { ...environment, [syncOperation]: operation }),
      { clearStale: options.clearStaleLock },
    )
  }
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

  applyInterfaceMetadata(interfaceJson, config)
  if (packageJson) applyPackageMetadata(packageJson, config)
  const pyproject = await syncedPyproject(root, config)

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
  // exists, leave it untouched and let lint/doctor drift checks surface any
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
  if (sync !== 'license') await writeProjectState(root, config)
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

function applyPackageMetadata(
  packageJson: Record<string, unknown>,
  config: Awaited<ReturnType<typeof readProjectConfig>>,
): void {
  packageJson.name = config.project.slug
  packageJson.version = config.project.version
  packageJson.license = config.license.spdx === 'None' ? 'UNLICENSED' : config.license.spdx
}

function applyInterfaceMetadata(
  interfaceJson: Record<string, unknown>,
  config: Awaited<ReturnType<typeof readProjectConfig>>,
): void {
  interfaceJson.name = config.project.slug
  interfaceJson.label = config.project.displayName
  interfaceJson.version = addV(config.project.version)
  interfaceJson.icon = 'logo.ico'
  interfaceJson.controller = interfaceController(projectControllerKinds(config))
  interfaceJson.resource = interfaceResourceItems(enabledResourcePacks(config))
  if (config.project.github) {
    interfaceJson.github = config.project.github
  } else {
    delete interfaceJson.github
  }
  if (config.python) {
    interfaceJson.agent = [
      interfaceAgent(config.python.devCommand),
    ]
  } else {
    delete interfaceJson.agent
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
