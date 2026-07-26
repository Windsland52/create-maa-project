import { join } from 'node:path'
import { readProjectConfig } from './project.js'
import type { MaaProjectConfig } from './types.js'
import { enabledResourcePacks, hasDevTools, hasGithubAutomation, isAddonEnabled } from './features.js'
import { exists, readText } from './utils.js'

export type DoctorReport = {
  ok: boolean
  lines: string[]
  checks: DoctorCheck[]
}

export type DoctorCheck = {
  id: string
  status: 'pass' | 'fail' | 'skipped'
  summary: string
  details: string[]
}

export async function runDoctor(root: string): Promise<DoctorReport> {
  const lines: string[] = []
  const checks: DoctorCheck[] = []
  let ok = true
  let config: MaaProjectConfig
  try {
    config = await readProjectConfig(root)
  } catch (error) {
    lines.push(`[ERR] maa-project.json could not be read: ${errorMessage(error)}`)
    lines.push(
      '      To fix: correct the JSON/config values or restore the file from version control or a project backup.',
    )
    recordDoctorCheck(checks, 'project-config', false, 'Project configuration could not be read.', lines)
    return { ok: false, lines, checks }
  }

  let detailStart = lines.length
  lines.push(`[OK] Project: ${config.project.displayName} (${config.project.slug})`)
  recordDoctorCheck(checks, 'project-config', true, 'Project configuration is valid.', lines, detailStart)

  detailStart = lines.length
  const interfaceJson = await readInterfaceJson(root, lines)
  recordDoctorCheck(
    checks,
    'interface-json',
    interfaceJson !== undefined,
    interfaceJson ? 'interface.json is present and valid.' : 'interface.json is missing or invalid.',
    lines,
    detailStart,
  )
  if (interfaceJson) {
    detailStart = lines.length
    const metadataOk = checkInterfaceMetadata(config, interfaceJson, lines)
    recordDoctorCheck(
      checks,
      'interface-metadata',
      metadataOk,
      metadataOk ? 'Interface metadata matches project configuration.' : 'Interface metadata has drifted.',
      lines,
      detailStart,
    )
    ok = metadataOk && ok
  } else {
    recordSkippedCheck(
      checks,
      'interface-metadata',
      'Interface metadata was not checked because interface.json is unavailable.',
    )
    ok = false
  }
  if (hasDevTools(config)) {
    detailStart = lines.length
    const nodeToolingOk = await checkNodeToolingFiles(root, config, lines)
    recordDoctorCheck(
      checks,
      'node-tooling',
      nodeToolingOk,
      nodeToolingOk ? 'Node tooling files are valid.' : 'Node tooling files need repair.',
      lines,
      detailStart,
    )
    ok = nodeToolingOk && ok
    if (config.features.vscode.enabled) {
      detailStart = lines.length
      const vscodeOk = await checkVscodeSettings(root, lines)
      recordDoctorCheck(
        checks,
        'vscode-settings',
        vscodeOk,
        vscodeOk ? 'VS Code settings are valid.' : 'VS Code settings need repair.',
        lines,
        detailStart,
      )
      ok = vscodeOk && ok
    } else {
      recordSkippedCheck(checks, 'vscode-settings', 'VS Code settings are disabled in project configuration.')
    }
    detailStart = lines.length
    const lockfileOk = await checkNodeLockfile(root, lines)
    recordDoctorCheck(
      checks,
      'node-lockfile',
      lockfileOk,
      lockfileOk ? 'The pnpm lockfile is present.' : 'The pnpm lockfile is missing.',
      lines,
      detailStart,
    )
    ok = lockfileOk && ok
  } else {
    recordSkippedCheck(checks, 'node-tooling', 'Node tooling is disabled in project configuration.')
    recordSkippedCheck(checks, 'vscode-settings', 'Node tooling is disabled in project configuration.')
    recordSkippedCheck(checks, 'node-lockfile', 'Node tooling is disabled in project configuration.')
  }
  if (config.python) {
    detailStart = lines.length
    const pythonToolingOk = await checkPythonTooling(root, config, lines)
    recordDoctorCheck(
      checks,
      'python-tooling',
      pythonToolingOk,
      pythonToolingOk ? 'Python Agent tooling files are valid.' : 'Python Agent tooling files need repair.',
      lines,
      detailStart,
    )
    ok = pythonToolingOk && ok
  } else {
    recordSkippedCheck(checks, 'python-tooling', 'Python Agent tooling is not enabled in project configuration.')
  }
  detailStart = lines.length
  const resourcesOk = await checkResourcePaths(root, config, lines)
  recordDoctorCheck(
    checks,
    'resource-paths',
    resourcesOk,
    resourcesOk ? 'Resource pack paths are present.' : 'A resource pack path is invalid or missing.',
    lines,
    detailStart,
  )
  ok = resourcesOk && ok
  if (interfaceJson) {
    detailStart = lines.length
    const referencesOk = await checkReferencedPaths(root, interfaceJson, lines)
    recordDoctorCheck(
      checks,
      'interface-paths',
      referencesOk,
      referencesOk ? 'Interface paths are valid and present.' : 'An interface path is invalid or missing.',
      lines,
      detailStart,
    )
    ok = referencesOk && ok
  } else {
    recordSkippedCheck(
      checks,
      'interface-paths',
      'Interface paths were not checked because interface.json is unavailable.',
    )
  }
  detailStart = lines.length
  const maatoolsOk = await checkMaatoolsConfig(root, config, lines)
  recordDoctorCheck(
    checks,
    'maatools-config',
    maatoolsOk,
    maatoolsOk ? 'Maa tools configuration is valid.' : 'Maa tools configuration needs repair.',
    lines,
    detailStart,
  )
  ok = maatoolsOk && ok

  return { ok, lines, checks }
}

function recordDoctorCheck(
  checks: DoctorCheck[],
  id: string,
  passed: boolean,
  summary: string,
  lines: string[],
  detailStart = 0,
): void {
  checks.push({
    id,
    status: passed ? 'pass' : 'fail',
    summary,
    details: lines.slice(detailStart),
  })
}

function recordSkippedCheck(checks: DoctorCheck[], id: string, summary: string): void {
  checks.push({ id, status: 'skipped', summary, details: [] })
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
  if (isAddonEnabled(config, 'schemaSync')) workflows.push('.github/workflows/schema-sync.yml')
  if (isAddonEnabled(config, 'optimizeImages')) workflows.push('.github/workflows/optimize-images.yml')
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

async function checkPythonTooling(root: string, config: MaaProjectConfig, lines: string[]): Promise<boolean> {
  const python = config.python
  if (!python) return true
  let ok = true
  let repairAgent = false
  let repairDependencies = false
  for (const path of [
    '.python-version',
    'pyproject.toml',
    'agent/bootstrap.py',
    'agent/main.py',
    'agent/agent_runtime.py',
  ]) {
    if (await exists(join(root, path))) continue
    lines.push(`[ERR] Required Python Agent file is missing: ${path}`)
    ok = false
    repairAgent = true
  }
  for (const path of [
    'requirements.in',
    'requirements.txt',
    'uv.lock',
  ]) {
    if (await exists(join(root, path))) continue
    lines.push(`[ERR] Required Python dependency file is missing: ${path}`)
    ok = false
    repairDependencies = true
  }

  const pythonVersionPath = join(root, '.python-version')
  if ((await exists(pythonVersionPath)) && (await readText(pythonVersionPath)).trim() !== python.recommendedPython) {
    lines.push(`[ERR] .python-version must match python.recommendedPython (${python.recommendedPython}).`)
    ok = false
    repairAgent = true
  }
  const pyprojectPath = join(root, 'pyproject.toml')
  if (await exists(pyprojectPath)) {
    const requiresPython = /^requires-python\s*=\s*["']([^"']+)["']/m.exec(await readText(pyprojectPath))?.[1]
    if (requiresPython !== python.requiresPython) {
      lines.push(`[ERR] pyproject.toml requires-python must match python.requiresPython (${python.requiresPython}).`)
      ok = false
      repairAgent = true
    }
  }

  if (repairAgent) lines.push('      To fix generated Agent files: create-maa-project --add agent')
  if (repairDependencies) lines.push('      To fix dependency files: create-maa-project --update python-deps')
  if (ok) lines.push('[OK] Python Agent files and dependency state are present.')
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
  for (const pack of enabledResourcePacks(config)) {
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
