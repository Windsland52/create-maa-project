import { join } from 'node:path'
import { readProjectConfig } from './project.js'
import type { MaaProjectConfig } from './types.js'
import { hasDevTools, hasGithubAutomation } from './features.js'
import { exists, readText } from './utils.js'

export type DoctorReport = {
  ok: boolean
  lines: string[]
}

export async function runDoctor(root: string): Promise<DoctorReport> {
  const lines: string[] = []
  let ok = true
  let config: MaaProjectConfig
  try {
    config = await readProjectConfig(root)
  } catch (error) {
    lines.push(`[ERR] maa-project.json could not be read: ${errorMessage(error)}`)
    lines.push(
      '      To fix: correct the JSON/config values or restore the file from version control or a project backup.',
    )
    return { ok: false, lines }
  }

  lines.push(`[OK] Project: ${config.project.displayName} (${config.project.slug})`)
  const interfaceJson = await readInterfaceJson(root, lines)
  if (interfaceJson) {
    ok = checkInterfaceMetadata(config, interfaceJson, lines) && ok
  } else {
    ok = false
  }
  if (hasDevTools(config)) {
    ok = (await checkNodeToolingFiles(root, config, lines)) && ok
    if (config.features.vscode.enabled) ok = (await checkVscodeSettings(root, lines)) && ok
    ok = (await checkNodeLockfile(root, lines)) && ok
  }
  ok = (await checkResourcePaths(root, config, lines)) && ok
  if (interfaceJson) ok = (await checkReferencedPaths(root, interfaceJson, lines)) && ok
  ok = (await checkMaatoolsConfig(root, config, lines)) && ok

  return { ok, lines }
}

async function readInterfaceJson(
  root: string,
  lines: string[],
): Promise<{ name?: unknown; github?: unknown; import?: unknown; resource?: unknown } | undefined> {
  const interfacePath = join(root, 'interface.json')
  if (!(await exists(interfacePath))) {
    lines.push('[ERR] interface.json is missing.')
    lines.push('      To fix: restore it from version control or a project backup.')
    return undefined
  }

  try {
    const value = JSON.parse(await readText(interfacePath)) as unknown
    if (!isRecord(value)) throw new Error('the top-level value must be an object')
    return value
  } catch (error) {
    lines.push(`[ERR] interface.json is not valid JSON: ${errorMessage(error)}`)
    lines.push('      To fix: correct the JSON or restore the file from version control or a project backup.')
    return undefined
  }
}

function checkInterfaceMetadata(
  config: MaaProjectConfig,
  interfaceJson: { name?: unknown; github?: unknown },
  lines: string[],
): boolean {
  let ok = true
  const unmanaged = config.project.interfaceUnmanaged === true
  if (interfaceJson.name !== config.project.slug) {
    if (unmanaged) {
      lines.push(
        '[INFO] interface.json name differs from maa-project.json project.slug; interface.json is unmanaged so this is allowed.',
      )
    } else {
      lines.push('[ERR] interface.json name differs from maa-project.json project.slug.')
      lines.push('      To fix: create-maa-project --sync metadata')
      ok = false
    }
  }
  if (interfaceJson.github !== config.project.github) {
    if (unmanaged) {
      lines.push(
        '[INFO] interface.json github differs from maa-project.json project.github; interface.json is unmanaged so this is allowed.',
      )
    } else {
      lines.push('[ERR] interface.json github differs from maa-project.json project.github.')
      lines.push('      To fix: create-maa-project --sync metadata')
      ok = false
    }
  }
  if (ok) lines.push('[OK] Interface metadata matches project config.')
  return ok
}

async function checkNodeLockfile(root: string, lines: string[]): Promise<boolean> {
  if (await exists(join(root, 'pnpm-lock.yaml'))) {
    lines.push('[OK] pnpm lockfile is present.')
    return true
  }
  lines.push('[ERR] pnpm-lock.yaml is missing.')
  lines.push('      To fix: pnpm install')
  return false
}

async function checkNodeToolingFiles(root: string, config: MaaProjectConfig, lines: string[]): Promise<boolean> {
  let ok = true
  for (const path of [
    'package.json',
    'pnpm-workspace.yaml',
    'tools/check-project.mjs',
    'tools/validate-schema.mjs',
    'tools/schema/interface.schema.json',
  ]) {
    if (await exists(join(root, path))) continue
    lines.push(`[ERR] Required project file is missing: ${path}`)
    lines.push('      To fix: restore it from version control or a project backup.')
    ok = false
  }

  const nodeVersionPath = join(root, '.node-version')
  if (!(await exists(nodeVersionPath))) {
    lines.push('[ERR] .node-version is missing.')
    lines.push('      To fix: restore it from version control or a project backup.')
    ok = false
  } else if ((await readText(nodeVersionPath)).trim() !== '24') {
    lines.push('[ERR] .node-version must pin Node 24.')
    lines.push('      To fix: set .node-version to 24.')
    ok = false
  }

  const workflows = hasGithubAutomation(config)
    ? [
        '.github/workflows/check.yml',
        '.github/workflows/release.yml',
      ]
    : []
  if (config.addons.schemaSync) workflows.push('.github/workflows/schema-sync.yml')
  if (config.addons.optimizeImages) workflows.push('.github/workflows/optimize-images.yml')
  for (const workflow of workflows) {
    const workflowPath = join(root, workflow)
    if (!(await exists(workflowPath))) {
      lines.push(`[ERR] ${workflow} is missing.`)
      lines.push('      To fix: restore it from version control or a project backup.')
      ok = false
      continue
    }
    if (!workflowPinsNode24(await readText(workflowPath))) {
      lines.push(`[ERR] ${workflow} must use Node 24 in actions/setup-node.`)
      lines.push('      To fix: update the workflow to use Node 24.')
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
    lines.push('      To fix: restore it from version control or a project backup.')
    return false
  }

  let settings: Record<string, unknown>
  try {
    const value = JSON.parse(await readText(settingsPath)) as unknown
    if (!isRecord(value)) throw new Error('the top-level value must be an object')
    settings = value
  } catch (error) {
    lines.push(`[ERR] .vscode/settings.json is not valid JSON: ${errorMessage(error)}`)
    lines.push('      To fix: correct the JSON or restore the generated VS Code settings.')
    return false
  }
  let ok = true
  if (settings['editor.formatOnSave'] !== true) {
    lines.push('[ERR] .vscode/settings.json editor.formatOnSave must be true.')
    lines.push('      To fix: set editor.formatOnSave to true.')
    ok = false
  }
  if (settings['files.eol'] !== '\n') {
    lines.push('[ERR] .vscode/settings.json files.eol must be LF.')
    lines.push('      To fix: set files.eol to LF.')
    ok = false
  }
  if (!hasJsoncFileAssociations(settings['files.associations'])) {
    lines.push('[ERR] .vscode/settings.json files.associations must map *.json and *.jsonc to jsonc.')
    lines.push('      To fix: restore the generated JSON/JSONC file associations.')
    ok = false
  }
  for (const language of [
    '[json]',
    '[jsonc]',
  ]) {
    if (editorDefaultFormatter(settings[language]) !== 'esbenp.prettier-vscode') {
      lines.push(`[ERR] .vscode/settings.json ${language} editor.defaultFormatter must be esbenp.prettier-vscode.`)
      lines.push('      To fix: set the formatter to esbenp.prettier-vscode.')
      ok = false
    }
  }
  if (!hasInterfaceJsonSchema(settings['json.schemas'])) {
    lines.push(
      '[ERR] .vscode/settings.json json.schemas must map /interface.json to ./tools/schema/interface.schema.json.',
    )
    lines.push('      To fix: restore the interface.json schema mapping.')
    ok = false
  }
  if (ok) lines.push('[OK] VS Code settings configure Prettier and interface schema.')
  return ok
}

async function checkResourcePaths(root: string, config: MaaProjectConfig, lines: string[]): Promise<boolean> {
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
  lines.push('[OK] Resource pack paths are present.')
  return true
}

async function checkReferencedPaths(
  root: string,
  interfaceJson: { import?: unknown; resource?: unknown },
  lines: string[],
): Promise<boolean> {
  let ok = true
  const references = [
    ...interfaceResourcePaths(interfaceJson.resource).map((path) => ({ kind: 'resource', path })),
    ...arrayOfStrings(interfaceJson.import).map((path) => ({ kind: 'import', path })),
  ]
  for (const reference of references) {
    if (reference.path.includes('\\')) {
      lines.push(`[ERR] interface.json ${reference.kind} path uses backslashes: ${reference.path}`)
      lines.push('      To fix: create-maa-project --sync metadata')
      ok = false
      continue
    }
    if (!isProjectRelativePath(reference.path)) {
      lines.push(`[ERR] interface.json ${reference.kind} path must stay within project root: ${reference.path}`)
      lines.push('      To fix: use a project-relative path without .. segments')
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

async function checkMaatoolsConfig(root: string, _config: MaaProjectConfig, lines: string[]): Promise<boolean> {
  const configPath = join(root, 'maatools.config.mts')
  if (!(await exists(configPath))) {
    lines.push('[ERR] maatools.config.mts is missing.')
    lines.push('      To fix: create-maa-project --sync metadata')
    return false
  }
  const content = await readText(configPath)
  if (content.includes('defineConfig')) {
    lines.push('[ERR] maatools.config.mts must not use @nekosu/maa-tools defineConfig.')
    lines.push('      To fix: create-maa-project --sync metadata')
    return false
  }
  if (!hasMaatoolsRequiredFields(content)) {
    lines.push('[ERR] maatools.config.mts is missing maa-tools check fields.')
    lines.push("      Expected maaVersion, interfacePath: 'interface.json', and check: {}.")
    lines.push('      To fix: create-maa-project --sync metadata')
    return false
  }
  lines.push('[OK] Maa tools config fields are present.')
  return true
}

function hasMaatoolsRequiredFields(content: string): boolean {
  return (
    /\bmaaVersion\s*:\s*['"][^'"]+['"]/.test(content) &&
    /\binterfacePath\s*:\s*['"]interface\.json['"]/.test(content) &&
    /\bcheck\s*:\s*\{/.test(content)
  )
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

function isProjectRelativePath(path: string): boolean {
  const stripped = stripDotSlash(path)
  return (
    stripped !== '' &&
    stripped !== '.' &&
    !stripped.startsWith('/') &&
    !/^[A-Za-z]:/.test(stripped) &&
    !stripped.split('/').includes('..')
  )
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
