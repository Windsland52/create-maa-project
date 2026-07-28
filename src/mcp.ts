import { spawn, type ChildProcess } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
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
import { throwIfAborted } from './utils.js'

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
  'addons',
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
  | 'get_project_context'
  | 'create_project'
  | 'doctor'
  | 'sync'
  | 'update'
  | 'add'
  | 'list_backups'
  | 'show_backup'
  | 'restore'
  | 'clean_cache'

type JsonObject = Record<string, unknown>
type McpServerContext = { root: string }
type SchemaObject = Record<string, unknown>
type OutputSchema = NonNullable<Tool['outputSchema']>
type SchemaComposition = { allOf?: SchemaObject[]; oneOf?: SchemaObject[] }

const STRING_ARRAY_OUTPUT_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
}
const PENDING_ITEM_OUTPUT_SCHEMA = closedObjectSchema(
  {
    kind: { type: 'string' },
    reason: { type: 'string' },
    command: { type: 'string' },
  },
  ['kind', 'reason', 'command'],
)
const SUGGESTED_COMMAND_OUTPUT_SCHEMA = closedObjectSchema(
  {
    command: { type: 'string' },
    description: { type: 'string' },
    autoRun: { type: 'boolean' },
  },
  ['command', 'description', 'autoRun'],
)
const REPORT_ERROR_OUTPUT_SCHEMA = closedObjectSchema(
  {
    message: { type: 'string' },
    code: { type: 'string' },
    causeCode: { type: 'string' },
  },
  ['message', 'code'],
)
const GIT_RESULT_OUTPUT_SCHEMA = closedObjectSchema(
  {
    initialized: { type: 'boolean' },
    committed: { type: 'boolean' },
    reason: { type: 'string' },
  },
  ['initialized', 'committed'],
)
const DOCTOR_CHECK_OUTPUT_SCHEMA = closedObjectSchema(
  {
    id: { type: 'string' },
    status: { type: 'string', enum: ['pass', 'fail', 'skipped'] },
    summary: { type: 'string' },
    details: STRING_ARRAY_OUTPUT_SCHEMA,
  },
  ['id', 'status', 'summary', 'details'],
)
const DOCTOR_RESULT_OUTPUT_SCHEMA = closedObjectSchema(
  {
    lines: STRING_ARRAY_OUTPUT_SCHEMA,
    checks: { type: 'array', items: DOCTOR_CHECK_OUTPUT_SCHEMA },
  },
  ['lines', 'checks'],
)
const BACKUP_INSPECTION_ENTRY_OUTPUT_SCHEMA = closedObjectSchema(
  {
    path: { type: 'string' },
    action: { type: 'string', enum: ['restore', 'remove'] },
  },
  ['path', 'action'],
)
const BACKUP_INSPECTION_OUTPUT_SCHEMA = closedObjectSchema(
  {
    id: { type: 'string' },
    format: { type: 'string', enum: ['managed-files', 'legacy'] },
    createdAt: { type: 'string' },
    command: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    status: {
      type: 'string',
      enum: ['in-progress', 'complete', 'rolled-back', 'rollback-failed', 'legacy'],
    },
    entries: { type: 'array', items: BACKUP_INSPECTION_ENTRY_OUTPUT_SCHEMA },
  },
  ['id', 'format', 'createdAt', 'command', 'status', 'entries'],
)
const BACKUP_SUMMARY_OUTPUT_SCHEMA = closedObjectSchema(
  {
    id: { type: 'string' },
    format: { type: 'string', enum: ['managed-files', 'legacy', 'invalid'] },
    createdAt: { type: 'string' },
    command: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    status: {
      type: 'string',
      enum: ['in-progress', 'complete', 'rolled-back', 'rollback-failed', 'legacy', 'invalid'],
    },
    entryCount: { type: 'integer', minimum: 0 },
    error: { type: 'string' },
  },
  ['id', 'format', 'createdAt', 'command', 'status', 'entryCount'],
)
const LIST_BACKUPS_RESULT_OUTPUT_SCHEMA = closedObjectSchema(
  {
    operation: { type: 'string', const: 'list' },
    backups: { type: 'array', items: BACKUP_SUMMARY_OUTPUT_SCHEMA },
  },
  ['operation', 'backups'],
)
const SHOW_BACKUP_RESULT_OUTPUT_SCHEMA = backupInspectionResultSchema('show')
const RESTORE_PREVIEW_RESULT_OUTPUT_SCHEMA = backupInspectionResultSchema('restore-preview')
const RESTORE_RESULT_OUTPUT_SCHEMA = closedObjectSchema(
  {
    operation: { type: 'string', const: 'restore' },
    backupId: { type: 'string' },
    restored: STRING_ARRAY_OUTPUT_SCHEMA,
    removed: STRING_ARRAY_OUTPUT_SCHEMA,
    preRestoreBackupId: { type: 'string' },
  },
  ['operation', 'backupId', 'restored', 'removed', 'preRestoreBackupId'],
)

const BASE_REPORT_PROPERTIES: Record<string, object> = {
  schemaVersion: { type: 'integer', const: 1 },
  tool: { type: 'string', const: 'create-maa-project' },
  command: { type: 'string' },
  ok: { type: 'boolean' },
  timestamp: { type: 'string' },
  durationMs: { type: 'integer', minimum: 0 },
  exitCode: { type: 'integer', enum: [0, 1] },
  executionId: { type: 'string' },
  root: { type: 'string' },
  logPath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  written: STRING_ARRAY_OUTPUT_SCHEMA,
  removed: STRING_ARRAY_OUTPUT_SCHEMA,
  skipped: STRING_ARRAY_OUTPUT_SCHEMA,
  pending: { type: 'array', items: PENDING_ITEM_OUTPUT_SCHEMA },
  suggestedCommands: { type: 'array', items: SUGGESTED_COMMAND_OUTPUT_SCHEMA },
  error: REPORT_ERROR_OUTPUT_SCHEMA,
}
const BASE_REPORT_REQUIRED = [
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
]

const PROJECT_CONTEXT_OUTPUT_SCHEMA: OutputSchema = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    tool: { type: 'string', const: 'get_project_context' },
    ok: { type: 'boolean' },
    serverRoot: { type: 'string' },
    projectPath: { type: 'string' },
    projectRoot: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    projectConfigPath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    hasProjectConfig: { type: 'boolean' },
    error: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  required: [
    'schemaVersion',
    'tool',
    'ok',
    'serverRoot',
    'projectPath',
    'projectRoot',
    'projectConfigPath',
    'hasProjectConfig',
  ],
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        ok: { const: true },
        projectRoot: { type: 'string' },
        projectConfigPath: { type: 'string' },
      },
      not: { required: ['error'] },
    },
    {
      properties: {
        ok: { const: false },
        projectRoot: { type: 'null' },
        projectConfigPath: { type: 'null' },
        hasProjectConfig: { const: false },
      },
      required: ['error'],
    },
  ],
}

const SCAFFOLD_REPORT_PROPERTIES: Record<string, object> = {
  backupId: { type: 'string' },
  backupScope: { type: 'string', const: 'managed-files' },
}
const TOOL_OUTPUT_SCHEMAS: Record<ToolName, OutputSchema> = {
  get_project_context: PROJECT_CONTEXT_OUTPUT_SCHEMA,
  create_project: reportOutputSchema('create', { ...SCAFFOLD_REPORT_PROPERTIES, git: GIT_RESULT_OUTPUT_SCHEMA }, [
    scaffoldResultVariant(),
  ]),
  doctor: reportOutputSchema('doctor', { doctor: DOCTOR_RESULT_OUTPUT_SCHEMA }, [
    reportResultVariant(true, ['doctor']),
    reportResultVariant(false, ['doctor'], {}, ['error']),
  ]),
  sync: reportOutputSchema('sync', SCAFFOLD_REPORT_PROPERTIES, [scaffoldResultVariant()]),
  update: reportOutputSchema('update', SCAFFOLD_REPORT_PROPERTIES, [scaffoldResultVariant()]),
  add: reportOutputSchema('add', SCAFFOLD_REPORT_PROPERTIES, [scaffoldResultVariant()]),
  list_backups: reportOutputSchema(
    'backup',
    {
      backupScope: { type: 'string', const: 'managed-files' },
      backup: LIST_BACKUPS_RESULT_OUTPUT_SCHEMA,
    },
    [reportResultVariant(true, ['backupScope', 'backup'])],
  ),
  show_backup: reportOutputSchema(
    'backup',
    {
      backupScope: { type: 'string', const: 'managed-files' },
      backup: SHOW_BACKUP_RESULT_OUTPUT_SCHEMA,
    },
    [reportResultVariant(true, ['backupScope', 'backup'])],
  ),
  restore: reportOutputSchema(
    'backup',
    {
      backupId: { type: 'string' },
      backupScope: { type: 'string', const: 'managed-files' },
      backup: {
        oneOf: [RESTORE_PREVIEW_RESULT_OUTPUT_SCHEMA, RESTORE_RESULT_OUTPUT_SCHEMA],
      },
    },
    [
      reportResultVariant(true, ['backupScope', 'backup'], { backup: RESTORE_PREVIEW_RESULT_OUTPUT_SCHEMA }, [
        'error',
        'backupId',
      ]),
      reportResultVariant(true, ['backupId', 'backupScope', 'backup'], { backup: RESTORE_RESULT_OUTPUT_SCHEMA }),
    ],
  ),
  clean_cache: reportOutputSchema('clean-cache', {}, [reportResultVariant(true)]),
}

const TOOL_ANNOTATIONS: Record<ToolName, NonNullable<Tool['annotations']>> = {
  get_project_context: toolAnnotations('Get MCP Project Context', true, false, true, false),
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

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    callTool(context, request.params.name, request.params.arguments, extra.signal),
  )

  return server
}

export async function startMcpServer(root = safeProcessCwd('.')): Promise<void> {
  const server = createMcpServer(await resolveMcpServerRoot(root))

  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stdin.resume()
  await waitForStdinClose()
}

const MCP_TOOL_DEFINITIONS: Tool[] = [
  {
    name: 'get_project_context',
    description:
      'Return the configured MCP server root and the resolved project directory. Call this before path-sensitive operations to confirm how projectPath is interpreted.',
    inputSchema: objectSchema({
      projectPath: projectPathSchema(),
    }),
  },
  {
    name: 'create_project',
    description:
      'Scaffold a new MaaFW project. MCP mode is non-interactive: before calling, collect the project folder/name, whether the user wants a pipeline or Python Agent project, controller targets, desired add-ons, and any resource-pack folder name. Use template="agent" for Python Agent projects. Use add=["dev-tools","github"] for a normal repository with checks and GitHub workflows. If add contains "resource-pack", provide resourcePackSlug.',
    inputSchema: objectSchema(
      {
        name: nonBlankStringSchema(
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
          { minItems: 1, uniqueItems: true },
        ),
        license: enumSchema(LICENSE_KINDS, 'Project license.'),
        network: enumSchema(NETWORK_MODES, 'Network asset source mode.'),
        add: arraySchema(
          enumSchema(ADDONS, 'Add-on name.'),
          'Create-time add-ons. Common repository setup is ["dev-tools","github"]. If this includes "resource-pack", resourcePackSlug is required.',
        ),
        resourcePackSlug: nonBlankStringSchema(
          'ASCII kebab-case resource pack folder name, such as extra or cn. Required when add includes "resource-pack".',
        ),
        resourcePackLabel: nonBlankStringSchema(
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
      {
        allOf: [
          {
            if: {
              required: ['add'],
              properties: { add: { contains: { const: 'resource-pack' } } },
            },
            then: { required: ['resourcePackSlug'] },
          },
          {
            if: { required: ['resourcePackLabel'] },
            then: { required: ['resourcePackSlug'] },
          },
        ],
      },
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
      {
        oneOf: [
          {
            properties: { target: { enum: ['config', 'metadata'] } },
            not: { required: ['value'] },
          },
          {
            properties: {
              target: { enum: ['display-name', 'version', 'github-url'] },
              value: nonBlankStringSchema('New metadata value.'),
            },
            required: ['value'],
          },
          {
            properties: {
              target: { const: 'license' },
              value: enumSchema(LICENSE_KINDS, 'New project license.'),
            },
            required: ['value'],
          },
          {
            properties: {
              target: { const: 'network' },
              value: enumSchema(NETWORK_MODES, 'New network mode.'),
            },
            required: ['value'],
          },
        ],
      },
    ),
  },
  {
    name: 'update',
    description: 'Update dependencies, runtime assets, or schema',
    inputSchema: objectSchema(
      {
        targets: arraySchema(enumSchema(UPDATE_TARGETS, 'Update target.'), 'Update targets.', { minItems: 1 }),
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
      'Apply one or more incremental add-ons to the selected project in one locked, backed-up operation. Pass exactly one of addon or addons. When the selection includes "resource-pack", ask the user for a resource pack folder name and pass resourcePackSlug.',
    inputSchema: objectSchema(
      {
        addon: enumSchema(ADDONS, 'Single add-on to apply. Use addons when applying more than one.'),
        addons: arraySchema(enumSchema(ADDONS, 'Add-on to apply.'), 'One or more add-ons to apply atomically.', {
          minItems: 1,
          uniqueItems: true,
        }),
        resourcePackSlug: nonBlankStringSchema(
          'ASCII kebab-case resource pack folder name, such as extra or cn. Required when addon or addons includes "resource-pack".',
        ),
        label: nonBlankStringSchema(
          'Optional resource pack display label. If omitted, it is derived from resourcePackSlug.',
        ),
        projectPath: projectPathSchema(),
      },
      [],
      {
        allOf: [
          {
            oneOf: [
              { required: ['addon'], not: { required: ['addons'] } },
              { required: ['addons'], not: { required: ['addon'] } },
            ],
          },
          {
            if: {
              anyOf: [
                { required: ['addon'], properties: { addon: { const: 'resource-pack' } } },
                { required: ['addons'], properties: { addons: { contains: { const: 'resource-pack' } } } },
              ],
            },
            then: { required: ['resourcePackSlug'] },
            else: { not: { anyOf: [{ required: ['resourcePackSlug'] }, { required: ['label'] }] } },
          },
        ],
      },
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
        backupId: nonBlankStringSchema('Managed-files backup id under .create-maa-project/backups.'),
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
        backupId: nonBlankStringSchema(
          'Managed-files backup id under .create-maa-project/backups; excludes .git state.',
        ),
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
  outputSchema: TOOL_OUTPUT_SCHEMAS[tool.name as ToolName],
  annotations: TOOL_ANNOTATIONS[tool.name as ToolName],
}))

async function callTool(
  context: McpServerContext,
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  throwIfAborted(signal)
  const toolName = name as ToolName
  switch (toolName) {
    case 'get_project_context':
      return callGetProjectContext(context, input)
    case 'create_project':
      return callCreateProject(context, input, signal)
    case 'doctor':
      return callDoctor(context, input)
    case 'sync':
      return callSync(context, input, signal)
    case 'update':
      return callUpdate(context, input, signal)
    case 'add':
      return callAdd(context, input, signal)
    case 'list_backups':
      return callListBackups(context, input)
    case 'show_backup':
      return callShowBackup(context, input)
    case 'restore':
      return callRestore(context, input, signal)
    case 'clean_cache':
      return callCleanCache(context, input, signal)
    default:
      return errorToolResult(context, 'create', new Error(`Unknown MCP tool: ${name}`))
  }
}

async function callGetProjectContext(context: McpServerContext, input: unknown): Promise<CallToolResult> {
  let projectPath = '.'
  try {
    const args = argsRecord(input, PROJECT_PATH_ARGUMENTS, 'get_project_context')
    projectPath = optionalString(args, 'projectPath') ?? '.'
    const serverRoot = await resolveMcpServerRoot(context.root)
    const projectRoot = await resolveMcpProjectRoot(serverRoot, args)
    const relativeProjectPath = relative(serverRoot, projectRoot).split(sep).join('/') || '.'
    const projectConfigPath = join(projectRoot, 'maa-project.json')
    let hasProjectConfig = false
    try {
      hasProjectConfig = (await stat(projectConfigPath)).isFile()
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error
    }
    return projectContextToolResult({
      schemaVersion: 1,
      tool: 'get_project_context',
      ok: true,
      serverRoot,
      projectPath: relativeProjectPath,
      projectRoot,
      projectConfigPath,
      hasProjectConfig,
    })
  } catch (error) {
    return projectContextToolResult(
      {
        schemaVersion: 1,
        tool: 'get_project_context',
        ok: false,
        serverRoot: resolve(context.root),
        projectPath,
        projectRoot: null,
        projectConfigPath: null,
        hasProjectConfig: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      },
      true,
    )
  }
}

async function callCreateProject(
  context: McpServerContext,
  input: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
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
  return withReport(
    { root: targetRoot },
    'create',
    async (reportContext) => {
      throwIfAborted(signal)
      const createOptions = await promptForCreateOptions(options)
      createOptions.name = targetRoot
      const result = await createProject(createOptions, {
        cwd: context.root,
        installNodeDeps: true,
        downloadOcrModels: true,
        commandRunner: (root, command, args) => runMcpChildCommand(root, command, args, signal),
        gitRunner: (root, args) => runMcpChildCommand(root, 'git', args, signal),
        ocrManifestResolver: () => resolveOcrManifestFromEnvironment(signal ? { signal } : {}),
        operationCommand,
        ...(signal ? { signal } : {}),
      })
      return createScaffoldJsonReport(reportContext, result)
    },
    signal ? { signal } : {},
  )
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

async function callSync(context: McpServerContext, input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
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
  return withReport(
    { root },
    'sync',
    async (reportContext) =>
      createScaffoldJsonReport(
        reportContext,
        await syncProject(options, { root, operationCommand, ...(signal ? { signal } : {}) }),
      ),
    signal ? { signal } : {},
  )
}

async function callUpdate(context: McpServerContext, input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
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
  return withReport(
    { root },
    'update',
    async (reportContext) => {
      throwIfAborted(signal)
      const result = await recordUpdateRequests(options, {
        root,
        operationCommand,
        commandRunner: (projectRoot, command, args) => runMcpChildCommand(projectRoot, command, args, signal),
        productManifestResolver: (request) => resolveProductAssetManifest(request, signal ? { signal } : {}),
        ocrManifestResolver: () => resolveOcrManifestFromEnvironment(signal ? { signal } : {}),
        ...(signal ? { signal } : {}),
      })
      return createScaffoldJsonReport(reportContext, result)
    },
    signal ? { signal } : {},
  )
}

async function callAdd(context: McpServerContext, input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
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
  return withReport(
    { root },
    'add',
    async (reportContext) => {
      const result = await applyIncrementalAddons(
        options,
        (line) => {
          process.stderr.write(`${line}\n`)
        },
        root,
        operationCommand,
        signal,
      )
      if (!result) {
        throw new Error(`No add-on was applied: ${options.add.join(', ')}`)
      }
      return createScaffoldJsonReport(reportContext, result)
    },
    signal ? { signal } : {},
  )
}

async function callRestore(context: McpServerContext, input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
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
  return withReport(
    { root },
    'backup',
    async (reportContext) => {
      throwIfAborted(signal)
      if (dryRun) {
        const backup = await withProjectLock(root, 'MCP restore preview', async () => {
          throwIfAborted(signal)
          const inspection = await inspectProjectBackup(root, backupId)
          throwIfAborted(signal)
          return inspection
        })
        return createBackupJsonReport({
          context: reportContext,
          root,
          backup: { operation: 'restore-preview', backup },
        })
      }
      const restoreResult = await restoreBackup(root, backupId, operationCommand, signal)
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
    },
    signal ? { signal } : {},
  )
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
    const backups = await listProjectBackups(root)
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
    const backup = await inspectProjectBackup(root, backupId)
    return createBackupJsonReport({
      context: reportContext,
      root,
      backup: { operation: 'show', backup },
    })
  })
}

async function callCleanCache(
  context: McpServerContext,
  input: unknown,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  let root: string
  try {
    const args = argsRecord(input, PROJECT_PATH_ARGUMENTS, 'clean_cache')
    root = await resolveMcpProjectRoot(context.root, args)
  } catch (error) {
    return errorToolResult(context, 'clean-cache', error)
  }
  return withReport(
    { root },
    'clean-cache',
    async (reportContext) => {
      return createCleanCacheJsonReport({
        context: reportContext,
        root,
        cachePath: await cleanCache(root, signal),
      })
    },
    signal ? { signal } : {},
  )
}

async function withReport(
  serverContext: McpServerContext,
  command: CliReportCommand,
  action: (context: ReportContext) => Promise<CliJsonReport>,
  options: { reportFailureIsError?: boolean; signal?: AbortSignal } = {},
): Promise<CallToolResult> {
  const startTimeMs = Date.now()
  const context = createMcpReportContext(command, startTimeMs)
  try {
    const report = await action(context)
    return reportToolResult(report, options.reportFailureIsError === false ? false : !report.ok)
  } catch (error) {
    if (options.signal?.aborted) throw error
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

function projectContextToolResult(output: JsonObject, isError = false): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(output),
      },
    ],
    structuredContent: output,
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
  const addon = optionalEnum(args, 'addon', ADDONS)
  const addons = optionalStringArray(args, 'addons', ADDONS)
  if ((addon === undefined) === (addons === undefined)) {
    throw new Error('Exactly one of addon or addons is required.')
  }
  const selectedAddons = addon === undefined ? (addons ?? []) : [addon]
  if (selectedAddons.length === 0) throw new Error('addons must contain at least one item.')
  if (new Set(selectedAddons).size !== selectedAddons.length) {
    throw new Error('addons must not contain duplicate values.')
  }
  const overrides: Partial<CliOptions> = {
    add: selectedAddons,
  }
  const resourcePackSlug = optionalString(args, 'resourcePackSlug')
  const label = optionalString(args, 'label')
  const includesResourcePack = selectedAddons.includes('resource-pack')
  if (includesResourcePack && !nonBlank(resourcePackSlug)) {
    throw new Error(
      'resourcePackSlug is required when addon or addons includes "resource-pack". Ask the user for an ASCII resource pack folder name such as extra or cn.',
    )
  }
  if (!includesResourcePack && (resourcePackSlug !== undefined || label !== undefined)) {
    throw new Error('resourcePackSlug and label are only valid when addon or addons includes "resource-pack".')
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

async function resolveMcpServerRoot(root: string): Promise<string> {
  const absoluteRoot = resolve(root)
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(absoluteRoot)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`MCP server root does not exist: ${absoluteRoot}`)
    }
    throw error
  }
  if (!(await stat(canonicalRoot)).isDirectory()) {
    throw new Error(`MCP server root must be a directory: ${absoluteRoot}`)
  }
  return canonicalRoot
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

async function runMcpChildCommand(root: string, command: string, args: string[], signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let aborted = false
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
    const onAbort = (): void => {
      aborted = true
      terminateChildProcess(child)
    }
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      cleanup()
      if (aborted || signal?.aborted) {
        try {
          throwIfAborted(signal)
        } catch (abortError) {
          rejectOnce(abortError instanceof Error ? abortError : new Error(String(abortError)))
          return
        }
      }
      rejectOnce(new Error(`Failed to run ${formatCommand(command, args)}. ${error.message}`))
    })
    child.on('close', (code, childSignal) => {
      cleanup()
      if (aborted || signal?.aborted) {
        try {
          throwIfAborted(signal)
        } catch (abortError) {
          rejectOnce(abortError instanceof Error ? abortError : new Error(String(abortError)))
          return
        }
      }
      if (code === 0) {
        resolveOnce()
        return
      }
      const suffix = childSignal ? `signal ${childSignal}` : `exit code ${code ?? 'unknown'}`
      rejectOnce(new Error(`Command failed: ${formatCommand(command, args)} (${suffix})`))
    })
  })
}

function terminateChildProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.once('error', () => {
      child.kill()
    })
    killer.once('close', (code) => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill()
    })
    return
  }
  child.kill('SIGTERM')
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 1000)
  forceKill.unref()
  child.once('close', () => clearTimeout(forceKill))
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

function objectSchema(
  properties: Record<string, object> = {},
  required: string[] = [],
  composition: SchemaComposition = {},
): Tool['inputSchema'] {
  const schema: Tool['inputSchema'] = {
    type: 'object',
    properties,
    additionalProperties: false,
    ...composition,
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

function nonBlankStringSchema(description: string): object {
  return {
    ...stringSchema(description),
    pattern: '\\S',
  }
}

function projectPathSchema(): object {
  return {
    ...stringSchema('Optional project directory relative to the MCP server root. Defaults to ".".'),
    minLength: 1,
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

function arraySchema(
  items: object,
  description: string,
  options: { minItems?: number; uniqueItems?: boolean } = {},
): object {
  return {
    type: 'array',
    items,
    description,
    ...options,
  }
}

function closedObjectSchema(properties: Record<string, object>, required: string[] = []): SchemaObject {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

function backupInspectionResultSchema(operation: 'show' | 'restore-preview'): SchemaObject {
  return closedObjectSchema(
    {
      operation: { type: 'string', const: operation },
      backup: BACKUP_INSPECTION_OUTPUT_SCHEMA,
    },
    ['operation', 'backup'],
  )
}

function reportOutputSchema(
  command: CliReportCommand,
  detailProperties: Record<string, object>,
  resultVariants: SchemaObject[],
): OutputSchema {
  const detailKeys = Object.keys(detailProperties)
  const errorVariant: SchemaObject = {
    properties: {
      ok: { const: false },
      exitCode: { const: 1 },
    },
    required: ['error'],
    ...(detailKeys.length > 0
      ? {
          not: {
            anyOf: detailKeys.map((key) => ({ required: [key] })),
          },
        }
      : {}),
  }
  return {
    type: 'object',
    properties: {
      ...BASE_REPORT_PROPERTIES,
      command: { type: 'string', const: command },
      ...detailProperties,
    },
    required: BASE_REPORT_REQUIRED,
    additionalProperties: false,
    oneOf: [
      ...resultVariants,
      errorVariant,
    ],
  }
}

function reportResultVariant(
  ok: boolean,
  required: string[] = [],
  properties: Record<string, object> = {},
  forbidden: string[] = ['error'],
): SchemaObject {
  return {
    properties: {
      ok: { const: ok },
      exitCode: { const: ok ? 0 : 1 },
      ...properties,
    },
    required,
    ...(forbidden.length > 0
      ? {
          not: {
            anyOf: forbidden.map((key) => ({ required: [key] })),
          },
        }
      : {}),
  }
}

function scaffoldResultVariant(): SchemaObject {
  return {
    allOf: [
      reportResultVariant(true),
      {
        oneOf: [
          { required: ['backupId', 'backupScope'] },
          {
            not: {
              anyOf: [{ required: ['backupId'] }, { required: ['backupScope'] }],
            },
          },
        ],
      },
    ],
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
