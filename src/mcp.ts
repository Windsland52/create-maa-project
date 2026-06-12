import { spawn } from 'node:child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js'
import { resolveOcrManifestFromEnvironment, resolveProductAssetManifest } from './assets.js'
import {
  controllerUnavailableMessage,
  normalizeControllerKind,
  uniqueControllerKinds
} from './controllers.js'
import { runDoctor } from './doctor.js'
import { applyIncrementalAddons } from './incremental-addons.js'
import {
  acceptManagedChanges,
  cleanCache,
  diffManagedFiles,
  listChangedManagedFiles,
  readProjectConfig,
  readProjectLock,
  restoreBackup,
  withProjectWriteLock
} from './project.js'
import { promptForCreateOptions } from './prompt.js'
import {
  createDiffJsonReport,
  createDoctorJsonReport,
  createErrorJsonReport,
  createReportExecutionId,
  createScaffoldJsonReport,
  type CliJsonReport,
  type CliReportCommand,
  type ReportContext
} from './report.js'
import { createProject } from './scaffold.js'
import { syncProject } from './sync.js'
import type { CliOptions, ControllerKind, ScaffoldResult } from './types.js'
import { previewTemplateUpdate, recordUpdateRequests } from './update.js'

const SERVER_VERSION = '0.1.0'

const TEMPLATE_NAMES = [
  'pipeline',
  'agent'
] as const
const LICENSE_KINDS = [
  'AGPL-3.0-or-later',
  'MIT',
  'None'
] as const
const NETWORK_MODES = [
  'auto',
  'official'
] as const
const SYNC_TARGETS = [
  'metadata',
  'display-name',
  'version',
  'license',
  'github-url',
  'network'
] as const
const UPDATE_TARGETS = [
  'schema',
  'maafw',
  'runtime:mfa',
  'ocr-models',
  'node-deps',
  'python-deps',
  'python-runtime',
  'template'
] as const
const ADDONS = [
  'dev-tools',
  'github',
  'agent',
  'resource-pack',
  'git-cliff',
  'auto-format',
  'optimize-images',
  'community',
  'dependabot',
  'schema-sync'
] as const

const SERVER_ROOT = safeProcessCwd('.')

type ToolName =
  | 'create_project'
  | 'doctor'
  | 'diff'
  | 'sync'
  | 'update'
  | 'add'
  | 'accept_changes'
  | 'restore'
  | 'clean_cache'

type JsonObject = Record<string, unknown>

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'create-maa-project', version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments)
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stdin.resume()
  await waitForStdinClose()
}

const MCP_TOOLS: Tool[] = [
  {
    name: 'create_project',
    description:
      'Scaffold a new MaaFW project. MCP mode is non-interactive: before calling, collect the project folder/name, whether the user wants a pipeline or Python Agent project, desired add-ons, and any resource-pack folder name. Use template="agent" for Python Agent projects. Use add=["dev-tools","github"] for a normal repository with checks and GitHub workflows. If add contains "resource-pack", provide resourcePackSlug.',
    inputSchema: objectSchema(
      {
        name: stringSchema('Project folder path or name. Ask the user for this before calling.'),
        template: enumSchema(
          TEMPLATE_NAMES,
          'Project template. Use "pipeline" for task/resource projects and "agent" when the user wants Python Agent custom logic.'
        ),
        slug: stringSchema('ASCII kebab-case project id.'),
        displayName: stringSchema('Human-readable project display name.'),
        controller: stringSchema('Comma-separated controller targets.'),
        license: enumSchema(LICENSE_KINDS, 'Project license.'),
        network: enumSchema(NETWORK_MODES, 'Network asset source mode.'),
        add: arraySchema(
          enumSchema(ADDONS, 'Add-on name.'),
          'Create-time add-ons. Common repository setup is ["dev-tools","github"]. If this includes "resource-pack", resourcePackSlug is required.'
        ),
        resourcePackSlug: stringSchema(
          'ASCII kebab-case resource pack folder name, such as extra or cn. Required when add includes "resource-pack".'
        ),
        resourcePackLabel: stringSchema(
          'Optional display label for the resource pack. If omitted, it is derived from resourcePackSlug.'
        ),
        skipDownload: booleanSchema('Skip runtime/OCR/dependency downloads.'),
        git: booleanSchema('Initialize a Git repository.')
      },
      [
        'name'
      ]
    )
  },
  {
    name: 'doctor',
    description: 'Check project health',
    inputSchema: objectSchema()
  },
  {
    name: 'diff',
    description: 'Show managed file drift',
    inputSchema: objectSchema()
  },
  {
    name: 'sync',
    description: 'Sync metadata fields',
    inputSchema: objectSchema(
      {
        target: enumSchema(SYNC_TARGETS, 'Metadata target to sync.'),
        value: stringSchema('New value for targets that require one.')
      },
      [
        'target'
      ]
    )
  },
  {
    name: 'update',
    description: 'Update dependencies, runtime assets, schema, or templates',
    inputSchema: objectSchema(
      {
        targets: arraySchema(enumSchema(UPDATE_TARGETS, 'Update target.'), 'Update targets.'),
        diff: booleanSchema('Preview template/schema changes instead of applying them.')
      },
      [
        'targets'
      ]
    )
  },
  {
    name: 'add',
    description:
      'Apply an incremental add-on to the project in the server cwd. MCP mode is non-interactive. When addon is "resource-pack", ask the user for a resource pack folder name and pass resourcePackSlug.',
    inputSchema: objectSchema(
      {
        addon: enumSchema(ADDONS, 'Add-on to apply.'),
        resourcePackSlug: stringSchema(
          'ASCII kebab-case resource pack folder name, such as extra or cn. Required when addon is "resource-pack".'
        ),
        label: stringSchema(
          'Optional resource pack display label. If omitted, it is derived from resourcePackSlug.'
        )
      },
      [
        'addon'
      ]
    )
  },
  {
    name: 'accept_changes',
    description: 'Accept managed file drift as the new baseline',
    inputSchema: objectSchema({
      paths: arraySchema(stringSchema('Managed file path.'), 'Specific files to accept.')
    })
  },
  {
    name: 'restore',
    description: 'Restore files from a backup',
    inputSchema: objectSchema(
      {
        backupId: stringSchema('Backup id under .create-maa-project/backups.')
      },
      [
        'backupId'
      ]
    )
  },
  {
    name: 'clean_cache',
    description: 'Clean local cache',
    inputSchema: objectSchema()
  }
]

async function callTool(name: string, input: unknown): Promise<CallToolResult> {
  const toolName = name as ToolName
  switch (toolName) {
    case 'create_project':
      return callCreateProject(input)
    case 'doctor':
      return withReport('doctor', async (context) => {
        const root = currentRoot()
        const doctor = await runDoctor(root)
        const lock = await readProjectLock(root)
        return createDoctorJsonReport({
          context,
          root,
          doctor,
          pending: lock.pending,
          changedManagedFiles: await listChangedManagedFiles(root)
        })
      })
    case 'diff':
      return withReport('diff', async (context) => {
        const root = currentRoot()
        return createDiffJsonReport({
          context,
          root,
          lines: await diffManagedFiles(root),
          changedManagedFiles: await listChangedManagedFiles(root)
        })
      })
    case 'sync':
      return callSync(input)
    case 'update':
      return callUpdate(input)
    case 'add':
      return callAdd(input)
    case 'accept_changes':
      return callAcceptChanges(input)
    case 'restore':
      return callRestore(input)
    case 'clean_cache':
      return callCleanCache()
    default:
      return errorToolResult('create', new Error(`Unknown MCP tool: ${name}`))
  }
}

async function callCreateProject(input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  try {
    options = createProjectOptions(argsRecord(input))
  } catch (error) {
    return errorToolResult('create', error)
  }
  return withReport('create', async (context) => {
    const createOptions = await promptForCreateOptions(options)
    const result = await createProject(createOptions, {
      installNodeDeps: true,
      downloadOcrModels: true,
      commandRunner: runMcpChildCommand,
      ocrManifestResolver: () => resolveOcrManifestFromEnvironment()
    })
    return createScaffoldJsonReport(context, result)
  })
}

async function callSync(input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  try {
    options = await syncOptions(argsRecord(input))
  } catch (error) {
    return errorToolResult('sync', error)
  }
  return withReport('sync', async (context) =>
    createScaffoldJsonReport(context, await syncProject(options))
  )
}

async function callUpdate(input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  try {
    options = updateOptions(argsRecord(input))
  } catch (error) {
    return errorToolResult('update', error)
  }
  if (options.diff) {
    return withReport('diff', async (context) =>
      createDiffJsonReport({
        context,
        root: currentRoot(),
        lines: await previewTemplateUpdate(options),
        changedManagedFiles: []
      })
    )
  }
  return withReport('update', async (context) => {
    const result = await recordUpdateRequests(options, {
      commandRunner: runMcpChildCommand,
      productManifestResolver: (request) => resolveProductAssetManifest(request),
      ocrManifestResolver: () => resolveOcrManifestFromEnvironment()
    })
    return createScaffoldJsonReport(context, result)
  })
}

async function callAdd(input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  try {
    options = addOptions(argsRecord(input))
  } catch (error) {
    return errorToolResult('update', error)
  }
  return withReport('update', async (context) => {
    const result = await applyIncrementalAddons(options, (line) => {
      process.stderr.write(`${line}\n`)
    })
    if (!result) {
      throw new Error(`No add-on was applied: ${options.add.join(', ')}`)
    }
    return createScaffoldJsonReport(context, result)
  })
}

async function callAcceptChanges(input: unknown): Promise<CallToolResult> {
  let paths: string[]
  try {
    paths = optionalStringArray(argsRecord(input), 'paths') ?? []
  } catch (error) {
    return errorToolResult('update', error)
  }
  return withReport('update', async (context) => {
    const root = currentRoot()
    const accepted = await withProjectWriteLock(
      root,
      'create-maa-project --mcp accept_changes',
      () => acceptManagedChanges(root, paths)
    )
    return createMaintenanceReport(context, root, accepted)
  })
}

async function callRestore(input: unknown): Promise<CallToolResult> {
  let backupId: string
  try {
    backupId = requiredString(argsRecord(input), 'backupId')
  } catch (error) {
    return errorToolResult('update', error)
  }
  return withReport('update', async (context) => {
    const root = currentRoot()
    const restored = await withProjectWriteLock(root, 'create-maa-project --mcp restore', () =>
      restoreBackup(root, backupId)
    )
    return createMaintenanceReport(context, root, restored)
  })
}

async function callCleanCache(): Promise<CallToolResult> {
  return withReport('update', async (context) => {
    const root = currentRoot()
    return createBaseReport(context, root, [
      await cleanCache(root)
    ])
  })
}

async function withReport(
  command: CliReportCommand,
  action: (context: ReportContext) => Promise<CliJsonReport>
): Promise<CallToolResult> {
  const startTimeMs = Date.now()
  const context = createMcpReportContext(command, startTimeMs)
  try {
    return reportToolResult(await action(context))
  } catch (error) {
    return reportToolResult(
      createErrorJsonReport({
        context,
        root: currentRoot(),
        error
      })
    )
  }
}

function createMcpReportContext(command: CliReportCommand, startTimeMs: number): ReportContext {
  return {
    command,
    startTimeMs,
    executionId: createReportExecutionId(new Date(startTimeMs)),
    logPath: null
  }
}

function errorToolResult(command: CliReportCommand, error: unknown): CallToolResult {
  const startTimeMs = Date.now()
  return reportToolResult(
    createErrorJsonReport({
      context: createMcpReportContext(command, startTimeMs),
      root: currentRoot(),
      error
    })
  )
}

function reportToolResult(report: CliJsonReport): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(report)
      }
    ],
    isError: !report.ok
  }
}

async function createMaintenanceReport(
  context: ReportContext,
  root: string,
  affectedPaths: string[]
): Promise<CliJsonReport> {
  const config = await readProjectConfig(root)
  const lock = await readProjectLock(root)
  const result: ScaffoldResult = {
    root,
    config,
    lock,
    written: affectedPaths,
    skipped: [],
    pending: lock.pending
  }
  return createScaffoldJsonReport(context, result)
}

function createBaseReport(
  context: ReportContext,
  root: string,
  affectedPaths: string[]
): CliJsonReport {
  return {
    schemaVersion: 1,
    tool: 'create-maa-project',
    command: context.command,
    ok: true,
    timestamp: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - context.startTimeMs),
    exitCode: 0,
    executionId: context.executionId,
    root,
    logPath: context.logPath,
    written: affectedPaths,
    skipped: [],
    pending: [],
    changedManagedFiles: [],
    changedUserFiles: [],
    suggestedCommands: []
  }
}

function createProjectOptions(args: JsonObject): CliOptions {
  const template = optionalEnum(args, 'template', TEMPLATE_NAMES) ?? 'pipeline'
  const controller = optionalString(args, 'controller')
  const resourcePackSlug = optionalString(args, 'resourcePackSlug')
  const resourcePackLabel = optionalString(args, 'resourcePackLabel')
  const add = [
    ...(optionalStringArray(args, 'add', ADDONS) ?? [])
  ]
  if (
    (resourcePackSlug !== undefined || resourcePackLabel !== undefined) &&
    !add.includes('resource-pack')
  ) {
    add.push('resource-pack')
  }
  if (add.includes('resource-pack') && !nonBlank(resourcePackSlug)) {
    throw new Error(
      'resourcePackSlug is required when add includes "resource-pack". Ask the user for an ASCII resource pack folder name such as extra or cn.'
    )
  }
  const overrides: Partial<CliOptions> = {
    name: requiredString(args, 'name'),
    template,
    explicitTemplate: optionalString(args, 'template') !== undefined,
    add,
    skipDownload: optionalBoolean(args, 'skipDownload') ?? false
  }
  const slug = optionalString(args, 'slug')
  const displayName = optionalString(args, 'displayName')
  const license = optionalEnum(args, 'license', LICENSE_KINDS)
  const network = optionalEnum(args, 'network', NETWORK_MODES)
  const initializeGit = optionalBoolean(args, 'git')
  if (slug !== undefined) overrides.slug = slug
  if (displayName !== undefined) overrides.displayName = displayName
  if (resourcePackSlug !== undefined) overrides.resourcePackSlug = resourcePackSlug
  if (resourcePackLabel !== undefined) overrides.label = resourcePackLabel
  if (controller) overrides.controllers = parseControllerOption(controller)
  if (license !== undefined) overrides.license = license
  if (network !== undefined) overrides.network = network
  if (initializeGit !== undefined) overrides.initializeGit = initializeGit
  return baseOptions(overrides)
}

async function syncOptions(args: JsonObject): Promise<CliOptions> {
  const target = requiredEnum(args, 'target', SYNC_TARGETS)
  const value = optionalString(args, 'value')
  if ([
      'display-name',
      'version',
      'license',
      'github-url'
    ].includes(target) && !value) {
    throw new Error(`sync target "${target}" requires value.`)
  }

  const options = baseOptions({
    sync: target
  })
  if (target === 'display-name') options.displayName = requiredString(args, 'value')
  if (target === 'version') options.version = requiredString(args, 'value')
  if (target === 'license') options.license = requiredEnum(args, 'value', LICENSE_KINDS)
  if (target === 'github-url') options.syncValue = requiredString(args, 'value')
  if (target === 'network') {
    options.network = value
      ? valueAsEnum(value, NETWORK_MODES, 'value')
      : (await readProjectConfig(currentRoot())).network.mode
  }
  return options
}

function updateOptions(args: JsonObject): CliOptions {
  return baseOptions({
    update: requiredStringArray(args, 'targets', UPDATE_TARGETS),
    diff: optionalBoolean(args, 'diff') ?? false
  })
}

function addOptions(args: JsonObject): CliOptions {
  const addon = requiredEnum(args, 'addon', ADDONS)
  const overrides: Partial<CliOptions> = {
    add: [
      addon
    ]
  }
  const resourcePackSlug = optionalString(args, 'resourcePackSlug')
  const label = optionalString(args, 'label')
  if (addon === 'resource-pack' && !nonBlank(resourcePackSlug)) {
    throw new Error(
      'resourcePackSlug is required when addon is "resource-pack". Ask the user for an ASCII resource pack folder name such as extra or cn.'
    )
  }
  if (resourcePackSlug !== undefined) overrides.resourcePackSlug = resourcePackSlug
  if (label !== undefined) overrides.label = label
  return baseOptions(overrides)
}

function baseOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    template: 'pipeline',
    add: [],
    update: [],
    doctor: false,
    diff: false,
    yes: true,
    noInteractive: true,
    force: false,
    clearStaleLock: false,
    allowNonGitDir: false,
    allowPendingCommit: false,
    skipDownload: false,
    verbose: false,
    noColor: true,
    assist: false,
    dryRun: false,
    acceptChanges: [],
    acceptChangesRequested: false,
    cleanCache: false,
    report: false,
    mcp: false,
    explicitTemplate: false,
    ...overrides
  }
}

function argsRecord(input: unknown): JsonObject {
  if (input === undefined) return {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Tool arguments must be an object.')
  }
  return input as JsonObject
}

function requiredString(args: JsonObject, key: string): string {
  const value = optionalString(args, key)
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${key} is required.`)
  }
  return value
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`)
  return value
}

function nonBlank(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

function optionalBoolean(args: JsonObject, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`)
  return value
}

function requiredEnum<T extends readonly string[]>(
  args: JsonObject,
  key: string,
  allowed: T
): T[number] {
  const value = requiredString(args, key)
  return valueAsEnum(value, allowed, key)
}

function optionalEnum<T extends readonly string[]>(
  args: JsonObject,
  key: string,
  allowed: T
): T[number] | undefined {
  const value = optionalString(args, key)
  return value === undefined ? undefined : valueAsEnum(value, allowed, key)
}

function valueAsEnum<T extends readonly string[]>(
  value: string,
  allowed: T,
  label: string
): T[number] {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

function requiredStringArray<T extends readonly string[]>(
  args: JsonObject,
  key: string,
  allowed?: T
): T extends readonly string[] ? T[number][] : string[] {
  const value = optionalStringArray(args, key, allowed)
  if (!value) throw new Error(`${key} is required.`)
  if (value.length === 0) throw new Error(`${key} must contain at least one item.`)
  return value as T extends readonly string[] ? T[number][] : string[]
}

function optionalStringArray<T extends readonly string[]>(
  args: JsonObject,
  key: string,
  allowed?: T
): (T extends readonly string[] ? T[number][] : string[]) | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`${key} must be an array.`)
  const strings: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${key} must contain only strings.`)
    if (allowed) valueAsEnum(item, allowed, key)
    strings.push(item)
  }
  return strings as T extends readonly string[] ? T[number][] : string[]
}

function parseControllerOption(value: string): ControllerKind[] {
  const kinds: ControllerKind[] = []
  for (const item of value.split(',')) {
    const kind = normalizeControllerKind(item)
    if (!kind) throw new Error(controllerUnavailableMessage(item.trim() || value))
    kinds.push(kind)
  }
  return uniqueControllerKinds(kinds)
}

async function runMcpChildCommand(root: string, command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const resolveOnce = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === 'win32',
      stdio: [
        'ignore',
        'pipe',
        'pipe'
      ]
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      rejectOnce(new Error(`Failed to run ${formatCommand(command, args)}. ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveOnce()
        return
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      rejectOnce(new Error(`Command failed: ${formatCommand(command, args)} (${suffix})`))
    })
  })
}

function currentRoot(): string {
  return safeProcessCwd(SERVER_ROOT)
}

function safeProcessCwd(fallback: string): string {
  try {
    return process.cwd()
  } catch {
    return fallback
  }
}

function formatCommand(command: string, args: string[]): string {
  return [
    command,
    ...args
  ].join(' ')
}

function objectSchema(
  properties: Record<string, object> = {},
  required: string[] = []
): Tool['inputSchema'] {
  const schema: Tool['inputSchema'] = {
    type: 'object',
    properties,
    additionalProperties: false
  }
  if (required.length > 0) schema.required = required
  return schema
}

function stringSchema(description: string): object {
  return {
    type: 'string',
    description
  }
}

function booleanSchema(description: string): object {
  return {
    type: 'boolean',
    description
  }
}

function enumSchema(values: readonly string[], description: string): object {
  return {
    type: 'string',
    enum: [
      ...values
    ],
    description
  }
}

function arraySchema(items: object, description: string): object {
  return {
    type: 'array',
    items,
    description
  }
}

async function waitForStdinClose(): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      process.stdin.off('end', done)
      process.stdin.off('close', done)
      resolve()
    }
    process.stdin.once('end', done)
    process.stdin.once('close', done)
  })
}
