import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
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
import { CONTROLLER_KINDS } from './controllers.js'
import { runDoctor } from './doctor.js'
import { applyIncrementalAddons } from './incremental-addons.js'
import { cleanCache, inspectProjectBackup, listProjectBackups, restoreBackup, withProjectLock } from './project.js'
import { promptForCreateOptions } from './prompt.js'
import {
  createBackupJsonReport,
  createCleanCacheJsonReport,
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
import type { CliOptions } from './types.js'
import { recordUpdateRequests } from './update.js'
import { UPDATE_TARGETS } from './update-targets.js'

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
const CREATE_PROJECT_ARGUMENTS = [
  'name',
  'template',
  'slug',
  'displayName',
  'controllers',
  'license',
  'network',
  'add',
  'resourcePackSlug',
  'resourcePackLabel',
  'skipDownload',
  'git',
] as const
const SYNC_ARGUMENTS = [
  'target',
  'value',
  'projectPath',
] as const
const UPDATE_ARGUMENTS = [
  'targets',
  'projectPath',
] as const
const ADD_ARGUMENTS = [
  'addon',
  'resourcePackSlug',
  'label',
  'projectPath',
] as const
const BACKUP_ARGUMENTS = [
  'backupId',
  'projectPath',
] as const
const RESTORE_ARGUMENTS = [
  ...BACKUP_ARGUMENTS,
  'dryRun',
] as const
const PROJECT_PATH_ARGUMENTS = [
  'projectPath',
] as const

type ToolName =
  'create_project' | 'doctor' | 'sync' | 'update' | 'add' | 'list_backups' | 'show_backup' | 'restore' | 'clean_cache'

type JsonObject = Record<string, unknown>
type McpServerContext = { root: string }

const REPORT_OUTPUT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    tool: { type: 'string', const: 'create-maa-project' },
    command: { type: 'string', enum: ['create', 'sync', 'update', 'add', 'doctor', 'backup', 'clean-cache'] },
    ok: { type: 'boolean' },
    timestamp: { type: 'string' },
    durationMs: { type: 'integer', minimum: 0 },
    exitCode: { type: 'integer', enum: [0, 1] },
    executionId: { type: 'string' },
    root: { type: 'string' },
    logPath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    written: { type: 'array', items: { type: 'string' } },
    removed: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'string' } },
    pending: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          reason: { type: 'string' },
          command: { type: 'string' },
        },
        required: ['kind', 'reason', 'command'],
      },
    },
    suggestedCommands: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          description: { type: 'string' },
          autoRun: { type: 'boolean' },
        },
        required: ['command', 'description', 'autoRun'],
      },
    },
    backupId: { type: 'string' },
    backupScope: { type: 'string', const: 'managed-files' },
    git: { type: 'object' },
    doctor: { type: 'object' },
    backup: { type: 'object' },
    error: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        code: { type: 'string' },
      },
      required: ['message'],
    },
  },
  required: [
    'schemaVersion',
    'tool',
    'command',
    'ok',
    'timestamp',
    'durationMs',
    'exitCode',
    'executionId',
    'root',
    'logPath',
    'written',
    'removed',
    'skipped',
    'pending',
    'suggestedCommands',
  ],
}

const TOOL_ANNOTATIONS: Record<ToolName, NonNullable<Tool['annotations']>> = {
  create_project: toolAnnotations('Create MaaFW Project', false, false, false, true),
  doctor: toolAnnotations('Diagnose MaaFW Project', true, false, true, false),
  sync: toolAnnotations('Synchronize Project Metadata', false, true, false, false),
  update: toolAnnotations('Update Project Dependencies', false, true, false, true),
  add: toolAnnotations('Add Project Capability', false, true, false, false),
  list_backups: toolAnnotations('List Project Backups', true, false, true, false),
  show_backup: toolAnnotations('Inspect Project Backup', true, false, true, false),
  restore: toolAnnotations('Restore Project Backup', false, true, false, false),
  clean_cache: toolAnnotations('Clean Project Cache', false, true, true, false),
}

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

const MCP_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'create_project',
    description:
      'Scaffold a new MaaFW project. MCP mode is non-interactive: before calling, collect the project folder/name, whether the user wants a pipeline or Python Agent project, controller targets, desired add-ons, and any resource-pack folder name. Use template="agent" for Python Agent projects. Use add=["dev-tools","github"] for a normal repository with checks and GitHub workflows. If add contains "resource-pack", provide resourcePackSlug.',
    inputSchema: objectSchema(
      {
        name: stringSchema(
          'Project folder path relative to the MCP server root. Use forward slashes for nested folders. Ask the user for this before calling.',
        ),
        template: enumSchema(
          TEMPLATE_NAMES,
          'Project template. Use "pipeline" for task/resource projects and "agent" when the user wants Python Agent custom logic.',
        ),
        slug: stringSchema('ASCII kebab-case project id.'),
        displayName: stringSchema('Human-readable project display name.'),
        controllers: arraySchema(
          enumSchema(CONTROLLER_KINDS, 'MaaFW controller target.'),
          'One or more controller targets. Ask the user which platforms the project supports.',
        ),
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
        'template',
        'controllers',
      ],
    ),
  },
  {
    name: 'doctor',
    description: 'Check project health',
    inputSchema: objectSchema({
      projectPath: projectPathSchema(),
    }),
  },
  {
    name: 'sync',
    description: 'Sync metadata fields',
    inputSchema: objectSchema(
      {
        target: enumSchema(SYNC_TARGETS, 'Metadata target to sync.'),
        value: stringSchema('New value for targets that require one.'),
        projectPath: projectPathSchema(),
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
        projectPath: projectPathSchema(),
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
        projectPath: projectPathSchema(),
      },
      [
        'addon',
      ],
    ),
  },
  {
    name: 'list_backups',
    description: 'List managed-files backups newest first. Git repository state under .git is never included.',
    inputSchema: objectSchema({
      projectPath: projectPathSchema(),
    }),
  },
  {
    name: 'show_backup',
    description: 'Inspect the paths and restore actions in a managed-files backup without changing the project.',
    inputSchema: objectSchema(
      {
        backupId: stringSchema('Managed-files backup id under .create-maa-project/backups.'),
        projectPath: projectPathSchema(),
      },
      [
        'backupId',
      ],
    ),
  },
  {
    name: 'restore',
    description:
      'Restore managed project files from a backup. Set dryRun=true to preview the same restore without changing files. Git repository state under .git is never included.',
    inputSchema: objectSchema(
      {
        backupId: stringSchema('Managed-files backup id under .create-maa-project/backups; excludes .git state.'),
        dryRun: booleanSchema('Preview the restore without changing project files.'),
        projectPath: projectPathSchema(),
      },
      [
        'backupId',
      ],
    ),
  },
  {
    name: 'clean_cache',
    description: 'Clean local cache',
    inputSchema: objectSchema({
      projectPath: projectPathSchema(),
    }),
  },
]

const MCP_TOOLS: Tool[] = MCP_TOOL_DEFINITIONS.map((tool) => ({
  ...tool,
  outputSchema: REPORT_OUTPUT_SCHEMA,
  annotations: TOOL_ANNOTATIONS[tool.name as ToolName],
}))

async function callTool(context: McpServerContext, name: string, input: unknown): Promise<CallToolResult> {
  const toolName = name as ToolName
  switch (toolName) {
    case 'create_project':
      return callCreateProject(context, input)
    case 'doctor':
      return callDoctor(context, input)
    case 'sync':
      return callSync(context, input)
    case 'update':
      return callUpdate(context, input)
    case 'add':
      return callAdd(context, input)
    case 'list_backups':
      return callListBackups(context, input)
    case 'show_backup':
      return callShowBackup(context, input)
    case 'restore':
      return callRestore(context, input)
    case 'clean_cache':
      return callCleanCache(context, input)
    default:
      return errorToolResult(context, 'create', new Error(`Unknown MCP tool: ${name}`))
  }
}

async function callCreateProject(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  let targetRoot: string
  let operationCommand: string
  try {
    const args = argsRecord(input, CREATE_PROJECT_ARGUMENTS, 'create_project')
    options = createProjectOptions(args)
    if (!options.name) throw new Error('name is required.')
    targetRoot = await resolveMcpCreateTarget(context.root, options.name)
    operationCommand = mcpOperationCommand('create_project', args)
  } catch (error) {
    return errorToolResult(context, 'create', error)
  }
  return withReport(context, 'create', async (reportContext) => {
    const createOptions = await promptForCreateOptions(options)
    createOptions.name = targetRoot
    const result = await createProject(createOptions, {
      cwd: context.root,
      installNodeDeps: true,
      downloadOcrModels: true,
      commandRunner: runMcpChildCommand,
      ocrManifestResolver: () => resolveOcrManifestFromEnvironment(),
      operationCommand,
    })
    return createScaffoldJsonReport(reportContext, result)
  })
}

async function callDoctor(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let root: string
  try {
    const args = argsRecord(input, PROJECT_PATH_ARGUMENTS, 'doctor')
    root = await resolveMcpProjectRoot(context.root, args)
  } catch (error) {
    return errorToolResult(context, 'doctor', error)
  }
  return withReport(
    { root },
    'doctor',
    async (reportContext) => {
      const doctor = await runDoctor(root)
      return createDoctorJsonReport({
        context: reportContext,
        root,
        doctor,
      })
    },
    { reportFailureIsError: false },
  )
}

async function callSync(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  let root: string
  let operationCommand: string
  try {
    const args = argsRecord(input, SYNC_ARGUMENTS, 'sync')
    options = syncOptions(args)
    root = await resolveMcpProjectRoot(context.root, args)
    operationCommand = mcpOperationCommand('sync', args)
  } catch (error) {
    return errorToolResult(context, 'sync', error)
  }
  return withReport({ root }, 'sync', async (reportContext) =>
    createScaffoldJsonReport(reportContext, await syncProject(options, { root, operationCommand })),
  )
}

async function callUpdate(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  let root: string
  let operationCommand: string
  try {
    const args = argsRecord(input, UPDATE_ARGUMENTS, 'update')
    options = updateOptions(args)
    root = await resolveMcpProjectRoot(context.root, args)
    operationCommand = mcpOperationCommand('update', args)
  } catch (error) {
    return errorToolResult(context, 'update', error)
  }
  return withReport({ root }, 'update', async (reportContext) => {
    const result = await recordUpdateRequests(options, {
      root,
      operationCommand,
      commandRunner: runMcpChildCommand,
      productManifestResolver: (request) => resolveProductAssetManifest(request),
      ocrManifestResolver: () => resolveOcrManifestFromEnvironment(),
    })
    return createScaffoldJsonReport(reportContext, result)
  })
}

async function callAdd(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let options: CliOptions
  let root: string
  let operationCommand: string
  try {
    const args = argsRecord(input, ADD_ARGUMENTS, 'add')
    options = addOptions(args)
    root = await resolveMcpProjectRoot(context.root, args)
    operationCommand = mcpOperationCommand('add', args)
  } catch (error) {
    return errorToolResult(context, 'add', error)
  }
  return withReport({ root }, 'add', async (reportContext) => {
    const result = await applyIncrementalAddons(
      options,
      (line) => {
        process.stderr.write(`${line}\n`)
      },
      root,
      operationCommand,
    )
    if (!result) {
      throw new Error(`No add-on was applied: ${options.add.join(', ')}`)
    }
    return createScaffoldJsonReport(reportContext, result)
  })
}

async function callRestore(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let backupId: string
  let dryRun: boolean
  let root: string
  let operationCommand: string
  try {
    const args = argsRecord(input, RESTORE_ARGUMENTS, 'restore')
    backupId = requiredString(args, 'backupId')
    dryRun = optionalBoolean(args, 'dryRun') ?? false
    root = await resolveMcpProjectRoot(context.root, args)
    operationCommand = mcpOperationCommand('restore', args)
  } catch (error) {
    return errorToolResult(context, 'backup', error)
  }
  return withReport({ root }, 'backup', async (reportContext) => {
    if (dryRun) {
      const backup = await withProjectLock(root, 'MCP restore preview', () => inspectProjectBackup(root, backupId))
      return createBackupJsonReport({
        context: reportContext,
        root,
        backup: { operation: 'restore-preview', backup },
      })
    }
    const restoreResult = await restoreBackup(root, backupId, operationCommand)
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

async function callListBackups(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let root: string
  try {
    const args = argsRecord(input, PROJECT_PATH_ARGUMENTS, 'list_backups')
    root = await resolveMcpProjectRoot(context.root, args)
  } catch (error) {
    return errorToolResult(context, 'backup', error)
  }
  return withReport({ root }, 'backup', async (reportContext) => {
    const backups = await withProjectLock(root, 'MCP list backups', () => listProjectBackups(root))
    return createBackupJsonReport({
      context: reportContext,
      root,
      backup: { operation: 'list', backups },
    })
  })
}

async function callShowBackup(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let backupId: string
  let root: string
  try {
    const args = argsRecord(input, BACKUP_ARGUMENTS, 'show_backup')
    backupId = requiredString(args, 'backupId')
    root = await resolveMcpProjectRoot(context.root, args)
  } catch (error) {
    return errorToolResult(context, 'backup', error)
  }
  return withReport({ root }, 'backup', async (reportContext) => {
    const backup = await withProjectLock(root, 'MCP show backup', () => inspectProjectBackup(root, backupId))
    return createBackupJsonReport({
      context: reportContext,
      root,
      backup: { operation: 'show', backup },
    })
  })
}

async function callCleanCache(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let root: string
  try {
    const args = argsRecord(input, PROJECT_PATH_ARGUMENTS, 'clean_cache')
    root = await resolveMcpProjectRoot(context.root, args)
  } catch (error) {
    return errorToolResult(context, 'clean-cache', error)
  }
  return withReport({ root }, 'clean-cache', async (reportContext) => {
    return createCleanCacheJsonReport({
      context: reportContext,
      root,
      cachePath: await cleanCache(root),
    })
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
    structuredContent: {
      ...report,
    },
    isError,
  }
}

function createProjectOptions(args: JsonObject): CliOptions {
  const template = requiredEnum(args, 'template', TEMPLATE_NAMES)
  const controllers = requiredStringArray(args, 'controllers', CONTROLLER_KINDS)
  if (new Set(controllers).size !== controllers.length) {
    throw new Error('controllers must not contain duplicate values.')
  }
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
    explicitTemplate: true,
    controllers,
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

function argsRecord(input: unknown, allowed: readonly string[], tool: ToolName): JsonObject {
  if (input === undefined) return {}
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Tool arguments must be an object.')
  }
  const args = input as JsonObject
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(args)
    .filter((key) => !allowedSet.has(key))
    .sort()
  if (unknown.length > 0) {
    const label = unknown.length === 1 ? 'argument' : 'arguments'
    throw new Error(`Unknown ${label} for MCP tool ${tool}: ${unknown.join(', ')}.`)
  }
  return args
}

async function resolveMcpProjectRoot(serverRoot: string, args: JsonObject): Promise<string> {
  const projectPath = optionalString(args, 'projectPath') ?? '.'
  assertMcpRelativePath(projectPath, 'projectPath')

  const canonicalServerRoot = await realpath(serverRoot)
  const candidate = await realpath(resolve(canonicalServerRoot, projectPath))
  assertMcpPathInsideRoot(canonicalServerRoot, candidate, 'projectPath')
  if (!(await stat(candidate)).isDirectory()) {
    throw new Error(`projectPath must resolve to a directory: ${projectPath}`)
  }
  return candidate
}

async function resolveMcpCreateTarget(serverRoot: string, projectPath: string): Promise<string> {
  assertMcpRelativePath(projectPath, 'name')
  const canonicalServerRoot = await realpath(serverRoot)
  const segments = projectPath === '.' ? [] : projectPath.split('/')
  let candidate = canonicalServerRoot

  for (let index = 0; index < segments.length; index += 1) {
    candidate = resolve(candidate, segments[index]!)
    assertMcpPathInsideRoot(canonicalServerRoot, candidate, 'name')
    try {
      const canonicalCandidate = await realpath(candidate)
      assertMcpPathInsideRoot(canonicalServerRoot, canonicalCandidate, 'name')
      candidate = canonicalCandidate
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        const unresolvedTarget = resolve(candidate, ...segments.slice(index + 1))
        assertMcpPathInsideRoot(canonicalServerRoot, unresolvedTarget, 'name')
        return unresolvedTarget
      }
      throw error
    }
  }

  return candidate
}

function assertMcpRelativePath(projectPath: string, label: 'name' | 'projectPath'): void {
  const segments = projectPath.split('/')
  if (
    projectPath.trim() !== projectPath ||
    projectPath === '' ||
    projectPath.includes('\\') ||
    isAbsolute(projectPath) ||
    /^[A-Za-z]:/.test(projectPath) ||
    (projectPath !== '.' && segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
  ) {
    throw new Error(`${label} must be "." or a forward-slash relative path inside the MCP server root.`)
  }
}

function assertMcpPathInsideRoot(serverRoot: string, candidate: string, label: 'name' | 'projectPath'): void {
  const relativePath = relative(serverRoot, candidate)
  if (
    relativePath !== '' &&
    (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`))
  ) {
    throw new Error(`${label} must resolve inside the MCP server root.`)
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
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

function mcpOperationCommand(tool: ToolName, args: JsonObject): string {
  return `MCP ${tool} ${JSON.stringify(args)}`
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

function projectPathSchema(): object {
  return stringSchema('Optional project directory relative to the MCP server root. Defaults to ".".')
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

function toolAnnotations(
  title: string,
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
): NonNullable<Tool['annotations']> {
  return {
    title,
    readOnlyHint,
    destructiveHint,
    idempotentHint,
    openWorldHint,
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
