import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import packageJson from '../package.json' with { type: 'json' }
import { resolveOcrManifestFromEnvironment, resolveProductAssetManifest } from './assets.js'
import { controllerUnavailableMessage, normalizeControllerKind, uniqueControllerKinds } from './controllers.js'
import { runDoctor } from './doctor.js'
import { applyIncrementalAddons } from './incremental-addons.js'
import { cleanCache, restoreBackup } from './project.js'
import { promptForCreateOptions } from './prompt.js'
import {
  createBackupJsonReport,
  createDoctorJsonReport,
  createErrorJsonReport,
  createReportExecutionId,
  createScaffoldJsonReport,
  type CliJsonReport,
  type CliReportCommand,
  type ReportContext,
} from './report.js'
import { createProject } from './scaffold.js'
import { syncProject } from './sync.js'
import type { CliOptions, ControllerKind } from './types.js'
import { recordUpdateRequests } from './update.js'

const TEMPLATE_NAMES = [
  'pipeline',
  'agent',
] as const
const LICENSE_KINDS = [
  'AGPL-3.0-or-later',
  'MIT',
  'None',
] as const
const NETWORK_MODES = [
  'auto',
  'official',
] as const
const SYNC_TARGETS = [
  'config',
  'metadata',
  'display-name',
  'version',
  'license',
  'github-url',
  'network',
] as const
const UPDATE_TARGETS = [
  'schema',
  'maafw',
  'runtime:mfa',
  'ocr-models',
  'node-deps',
  'python-deps',
  'python-runtime',
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
  'schema-sync',
] as const

type ToolName = 'create_project' | 'doctor' | 'sync' | 'update' | 'add' | 'restore' | 'clean_cache'

type JsonObject = Record<string, unknown>
type McpServerContext = { root: string }

export function createMcpServer(root = safeProcessCwd('.')): Server {
  const context: McpServerContext = { root: resolve(root) }
  const server = new Server(
    { name: 'create-maa-project', version: packageJson.version },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(context, request.params.name, request.params.arguments),
  )

  return server
}

export async function startMcpServer(): Promise<void> {
  const server = createMcpServer()

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
          'Project template. Use "pipeline" for task/resource projects and "agent" when the user wants Python Agent custom logic.',
        ),
        slug: stringSchema('ASCII kebab-case project id.'),
        displayName: stringSchema('Human-readable project display name.'),
        controller: stringSchema('Comma-separated controller targets.'),
        license: enumSchema(LICENSE_KINDS, 'Project license.'),
        network: enumSchema(NETWORK_MODES, 'Network asset source mode.'),
        add: arraySchema(
          enumSchema(ADDONS, 'Add-on name.'),
          'Create-time add-ons. Common repository setup is ["dev-tools","github"]. If this includes "resource-pack", resourcePackSlug is required.',
        ),
        resourcePackSlug: stringSchema(
          'ASCII kebab-case resource pack folder name, such as extra or cn. Required when add includes "resource-pack".',
        ),
        resourcePackLabel: stringSchema(
          'Optional display label for the resource pack. If omitted, it is derived from resourcePackSlug.',
        ),
        skipDownload: booleanSchema('Skip runtime/OCR/dependency downloads.'),
        git: booleanSchema('Initialize a Git repository.'),
      },
      [
        'name',
      ],
    ),
  },
  {
    name: 'doctor',
    description: 'Check project health',
    inputSchema: objectSchema(),
  },
  {
    name: 'sync',
    description: 'Sync metadata fields',
    inputSchema: objectSchema(
      {
        target: enumSchema(SYNC_TARGETS, 'Metadata target to sync.'),
        value: stringSchema('New value for targets that require one.'),
      },
      [
        'target',
      ],
    ),
  },
  {
    name: 'update',
    description: 'Update dependencies, runtime assets, or schema',
    inputSchema: objectSchema(
      {
        targets: arraySchema(enumSchema(UPDATE_TARGETS, 'Update target.'), 'Update targets.'),
      },
      [
        'targets',
      ],
    ),
  },
  {
    name: 'add',
    description:
      'Apply an incremental add-on to the project in the server cwd. MCP mode is non-interactive. When addon is "resource-pack", ask the user for a resource pack folder name and pass resourcePackSlug.',
    inputSchema: objectSchema(
      {
        addon: enumSchema(ADDONS, 'Add-on to apply.'),
        resourcePackSlug: stringSchema(
          'ASCII kebab-case resource pack folder name, such as extra or cn. Required when addon is "resource-pack".',
        ),
        label: stringSchema('Optional resource pack display label. If omitted, it is derived from resourcePackSlug.'),
      },
      [
        'addon',
      ],
    ),
  },
  {
    name: 'restore',
    description: 'Restore managed project files from a backup. Git repository state under .git is never included.',
    inputSchema: objectSchema(
      {
        backupId: stringSchema('Managed-files backup id under .create-maa-project/backups; excludes .git state.'),
      },
      [
        'backupId',
      ],
    ),
  },
  {
    name: 'clean_cache',
    description: 'Clean local cache',
    inputSchema: objectSchema(),
  },
]

async function callTool(context: McpServerContext, name: string, input: unknown): Promise<CallToolResult> {
  const toolName = name as ToolName
  switch (toolName) {
    case 'create_project':
      return callCreateProject(context, input)
    case 'doctor':
      return withReport(
        context,
        'doctor',
        async (reportContext) => {
          const root = context.root
          if (!(await stat(root)).isDirectory()) throw new Error(`MCP project root is not a directory: ${root}`)
          const doctor = await runDoctor(root)
          return createDoctorJsonReport({
            context: reportContext,
            root,
            doctor,
          })
        },
        { reportFailureIsError: false },
      )
    case 'sync':
      return callSync(context, input)
    case 'update':
      return callUpdate(context, input)
    case 'add':
      return callAdd(context, input)
    case 'restore':
      return callRestore(context, input)
    case 'clean_cache':
      return callCleanCache(context)
    default:
      return errorToolResult(context, 'create', new Error(`Unknown MCP tool: ${name}`))
  }
}

async function callCreateProject(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  try {
    options = createProjectOptions(argsRecord(input))
  } catch (error) {
    return errorToolResult(context, 'create', error)
  }
  return withReport(context, 'create', async (reportContext) => {
    const createOptions = await promptForCreateOptions(options)
    const result = await createProject(createOptions, {
      cwd: context.root,
      installNodeDeps: true,
      downloadOcrModels: true,
      commandRunner: runMcpChildCommand,
      ocrManifestResolver: () => resolveOcrManifestFromEnvironment(),
    })
    return createScaffoldJsonReport(reportContext, result)
  })
}

async function callSync(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  try {
    options = syncOptions(argsRecord(input))
  } catch (error) {
    return errorToolResult(context, 'sync', error)
  }
  return withReport(context, 'sync', async (reportContext) =>
    createScaffoldJsonReport(reportContext, await syncProject(options, { root: context.root })),
  )
}

async function callUpdate(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  try {
    options = updateOptions(argsRecord(input))
  } catch (error) {
    return errorToolResult(context, 'update', error)
  }
  return withReport(context, 'update', async (reportContext) => {
    const result = await recordUpdateRequests(options, {
      root: context.root,
      commandRunner: runMcpChildCommand,
      productManifestResolver: (request) => resolveProductAssetManifest(request),
      ocrManifestResolver: () => resolveOcrManifestFromEnvironment(),
    })
    return createScaffoldJsonReport(reportContext, result)
  })
}

async function callAdd(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  try {
    options = addOptions(argsRecord(input))
  } catch (error) {
    return errorToolResult(context, 'update', error)
  }
  return withReport(context, 'update', async (reportContext) => {
    const result = await applyIncrementalAddons(
      options,
      (line) => {
        process.stderr.write(`${line}\n`)
      },
      context.root,
    )
    if (!result) {
      throw new Error(`No add-on was applied: ${options.add.join(', ')}`)
    }
    return createScaffoldJsonReport(reportContext, result)
  })
}

async function callRestore(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let backupId: string
  try {
    backupId = requiredString(argsRecord(input), 'backupId')
  } catch (error) {
    return errorToolResult(context, 'backup', error)
  }
  return withReport(context, 'backup', async (reportContext) => {
    const root = context.root
    const restoreResult = await restoreBackup(root, backupId)
    return createBackupJsonReport({
      context: reportContext,
      root,
      backup: {
        operation: 'restore',
        backupId,
        restored: restoreResult.restored,
        removed: restoreResult.removed,
        preRestoreBackupId: restoreResult.backupId,
      },
    })
  })
}

async function callCleanCache(context: McpServerContext): Promise<CallToolResult> {
  return withReport(context, 'update', async (reportContext) => {
    const root = context.root
    return createBaseReport(reportContext, root, [
      await cleanCache(root),
    ])
  })
}

async function withReport(
  serverContext: McpServerContext,
  command: CliReportCommand,
  action: (context: ReportContext) => Promise<CliJsonReport>,
  options: { reportFailureIsError?: boolean } = {},
): Promise<CallToolResult> {
  const startTimeMs = Date.now()
  const context = createMcpReportContext(command, startTimeMs)
  try {
    const report = await action(context)
    return reportToolResult(report, options.reportFailureIsError === false ? false : !report.ok)
  } catch (error) {
    return reportToolResult(
      createErrorJsonReport({
        context,
        root: serverContext.root,
        error,
      }),
      true,
    )
  }
}

function createMcpReportContext(command: CliReportCommand, startTimeMs: number): ReportContext {
  return {
    command,
    startTimeMs,
    executionId: createReportExecutionId(new Date(startTimeMs)),
    logPath: null,
  }
}

function errorToolResult(context: McpServerContext, command: CliReportCommand, error: unknown): CallToolResult {
  const startTimeMs = Date.now()
  return reportToolResult(
    createErrorJsonReport({
      context: createMcpReportContext(command, startTimeMs),
      root: context.root,
      error,
    }),
  )
}

function reportToolResult(report: CliJsonReport, isError = !report.ok): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(report),
      },
    ],
    isError,
  }
}

function createBaseReport(context: ReportContext, root: string, affectedPaths: string[]): CliJsonReport {
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
    removed: [],
    skipped: [],
    pending: [],
    suggestedCommands: [],
  }
}

function createProjectOptions(args: JsonObject): CliOptions {
  const template = optionalEnum(args, 'template', TEMPLATE_NAMES) ?? 'pipeline'
  const controller = optionalString(args, 'controller')
  const resourcePackSlug = optionalString(args, 'resourcePackSlug')
  const resourcePackLabel = optionalString(args, 'resourcePackLabel')
  const add = [
    ...(optionalStringArray(args, 'add', ADDONS) ?? []),
  ]
  if ((resourcePackSlug !== undefined || resourcePackLabel !== undefined) && !add.includes('resource-pack')) {
    add.push('resource-pack')
  }
  if (add.includes('resource-pack') && !nonBlank(resourcePackSlug)) {
    throw new Error(
      'resourcePackSlug is required when add includes "resource-pack". Ask the user for an ASCII resource pack folder name such as extra or cn.',
    )
  }
  const overrides: Partial<CliOptions> = {
    name: requiredString(args, 'name'),
    template,
    explicitTemplate: optionalString(args, 'template') !== undefined,
    add,
    skipDownload: optionalBoolean(args, 'skipDownload') ?? false,
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

function syncOptions(args: JsonObject): CliOptions {
  const target = requiredEnum(args, 'target', SYNC_TARGETS)
  const value = optionalString(args, 'value')
  if (
    [
      'display-name',
      'version',
      'license',
      'github-url',
      'network',
    ].includes(target) &&
    !value
  ) {
    throw new Error(`sync target "${target}" requires value.`)
  }
  if (
    [
      'config',
      'metadata',
    ].includes(target) &&
    value !== undefined
  ) {
    throw new Error(`sync target "${target}" does not accept value.`)
  }

  const options = baseOptions({
    sync: target,
  })
  if (target === 'display-name') options.displayName = requiredString(args, 'value')
  if (target === 'version') options.version = requiredString(args, 'value')
  if (target === 'license') options.license = requiredEnum(args, 'value', LICENSE_KINDS)
  if (target === 'github-url') options.syncValue = requiredString(args, 'value')
  if (target === 'network') options.network = requiredEnum(args, 'value', NETWORK_MODES)
  return options
}

function updateOptions(args: JsonObject): CliOptions {
  return baseOptions({
    update: requiredStringArray(args, 'targets', UPDATE_TARGETS),
  })
}

function addOptions(args: JsonObject): CliOptions {
  const addon = requiredEnum(args, 'addon', ADDONS)
  const overrides: Partial<CliOptions> = {
    add: [
      addon,
    ],
  }
  const resourcePackSlug = optionalString(args, 'resourcePackSlug')
  const label = optionalString(args, 'label')
  if (addon === 'resource-pack' && !nonBlank(resourcePackSlug)) {
    throw new Error(
      'resourcePackSlug is required when addon is "resource-pack". Ask the user for an ASCII resource pack folder name such as extra or cn.',
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
    listBackups: false,
    cleanCache: false,
    report: false,
    mcp: false,
    explicitTemplate: false,
    ...overrides,
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

function requiredEnum<T extends readonly string[]>(args: JsonObject, key: string, allowed: T): T[number] {
  const value = requiredString(args, key)
  return valueAsEnum(value, allowed, key)
}

function optionalEnum<T extends readonly string[]>(args: JsonObject, key: string, allowed: T): T[number] | undefined {
  const value = optionalString(args, key)
  return value === undefined ? undefined : valueAsEnum(value, allowed, key)
}

function valueAsEnum<T extends readonly string[]>(value: string, allowed: T, label: string): T[number] {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

function requiredStringArray<T extends readonly string[]>(
  args: JsonObject,
  key: string,
  allowed?: T,
): T extends readonly string[] ? T[number][] : string[] {
  const value = optionalStringArray(args, key, allowed)
  if (!value) throw new Error(`${key} is required.`)
  if (value.length === 0) throw new Error(`${key} must contain at least one item.`)
  return value as T extends readonly string[] ? T[number][] : string[]
}

function optionalStringArray<T extends readonly string[]>(
  args: JsonObject,
  key: string,
  allowed?: T,
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
        'pipe',
      ],
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
    ...args,
  ].join(' ')
}

function objectSchema(properties: Record<string, object> = {}, required: string[] = []): Tool['inputSchema'] {
  const schema: Tool['inputSchema'] = {
    type: 'object',
    properties,
    additionalProperties: false,
  }
  if (required.length > 0) schema.required = required
  return schema
}

function stringSchema(description: string): object {
  return {
    type: 'string',
    description,
  }
}

function booleanSchema(description: string): object {
  return {
    type: 'boolean',
    description,
  }
}

function enumSchema(values: readonly string[], description: string): object {
  return {
    type: 'string',
    enum: [
      ...values,
    ],
    description,
  }
}

function arraySchema(items: object, description: string): object {
  return {
    type: 'array',
    items,
    description,
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
