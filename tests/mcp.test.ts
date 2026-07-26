import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }
import { createMcpServer } from '../src/mcp.js'
import { inspectProjectBackup, listProjectBackups } from '../src/project.js'
import { testChildEnv } from './child-env.js'

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

type JsonReport = {
  schemaVersion: 1
  tool: 'create-maa-project'
  command: string
  ok: boolean
  exitCode: number
  root: string
  pending: Array<{ kind: string; reason: string; command: string }>
  written: string[]
  removed: string[]
  backupId?: string
  backupScope?: string
  backup?: {
    operation: string
    backupId?: string
    restored?: string[]
    removed?: string[]
    preRestoreBackupId?: string
  }
  doctor?: { lines: string[] }
  error?: { message: string; code?: string }
}

type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

type ToolListResult = {
  tools: Array<{
    name: string
    description?: string
    inputSchema: {
      type: 'object'
      properties?: Record<string, unknown>
      required?: string[]
    }
  }>
}

const execFileAsync = promisify(execFile)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const distCli = join(repoRoot, 'dist/index.js')
const tempRoots: string[] = []
const sessions: McpSession[] = []
const MCP_TEST_TIMEOUT_MS = 40000

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

afterAll(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

describe('MCP server', () => {
  it(
    'responds to initialize over MCP transport',
    async () => {
      const session = await startSession(await tempRoot())
      const response = await initialize(session)

      expect(response.error).toBeUndefined()
      expect(response.result).toMatchObject({
        serverInfo: {
          name: 'create-maa-project',
          version: packageJson.version,
        },
        capabilities: {
          tools: {},
        },
      })
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'lists all MCP tools with expected schemas',
    async () => {
      const session = await startSession(await tempRoot())
      await initialize(session)

      const response = await session.request('tools/list')
      expect(response.error).toBeUndefined()
      const tools = (response.result as ToolListResult).tools
      expect(tools.map((tool) => tool.name)).toEqual([
        'create_project',
        'doctor',
        'sync',
        'update',
        'add',
        'restore',
        'clean_cache',
      ])
      expect(toolByName(tools, 'create_project').inputSchema.required).toEqual([
        'name',
      ])
      expect(toolByName(tools, 'sync').inputSchema.required).toEqual([
        'target',
      ])
      expect(toolByName(tools, 'sync').inputSchema.properties?.target).toMatchObject({
        enum: expect.arrayContaining([
          'config',
          'metadata',
        ]),
      })
      expect(toolByName(tools, 'update').inputSchema.required).toEqual([
        'targets',
      ])
      expect(toolByName(tools, 'update').inputSchema.properties?.targets).toMatchObject({
        items: {
          enum: expect.arrayContaining([
            'runtime:mfa',
            'runtime:mxu',
          ]),
        },
      })
      expect(toolByName(tools, 'add').inputSchema.properties?.addon).toMatchObject({
        enum: expect.arrayContaining([
          'dev-tools',
          'resource-pack',
          'schema-sync',
        ]),
      })
      expect(toolByName(tools, 'create_project').description).toContain('MCP mode is non-interactive')
      expect(toolByName(tools, 'create_project').inputSchema.properties?.resourcePackSlug).toMatchObject({
        type: 'string',
        description: expect.stringContaining('Required when add includes "resource-pack"'),
      })
      expect(toolByName(tools, 'create_project').inputSchema.properties?.resourcePackLabel).toMatchObject({
        type: 'string',
      })
      expect(toolByName(tools, 'add').description).toContain('resourcePackSlug')
      expect(toolByName(tools, 'add').inputSchema.properties?.resourcePackSlug).toMatchObject({
        type: 'string',
        description: expect.stringContaining('Required when addon is "resource-pack"'),
      })
      for (const name of [
        'doctor',
        'sync',
        'update',
        'add',
        'restore',
        'clean_cache',
      ]) {
        expect(toolByName(tools, name).inputSchema.properties?.projectPath, name).toMatchObject({
          type: 'string',
          description: expect.stringContaining('relative to the MCP server root'),
        })
      }
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'keeps resource-pack labels separate from the project display name',
    async () => {
      const root = await tempRoot()
      const session = await startSession(root)
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'create_project',
        arguments: {
          name: 'maa-mcp-labeled-pack',
          add: [
            'resource-pack',
          ],
          resourcePackSlug: 'extra',
          resourcePackLabel: 'Extra Resource',
          skipDownload: true,
        },
      })
      const { result, report } = parseToolReport(response)
      const config = JSON.parse(await readFile(join(root, 'maa-mcp-labeled-pack', 'maa-project.json'), 'utf8')) as {
        project: { displayName: string }
        resources: Array<{ slug: string; label: string }>
      }

      expect(result.isError).toBeFalsy()
      expect(report).toMatchObject({ command: 'create', ok: true, root: join(root, 'maa-mcp-labeled-pack') })
      expect(config.project.displayName).toBe('maa-mcp-labeled-pack')
      expect(config.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: 'extra', label: 'Extra Resource' }),
        ]),
      )
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'returns a successful CliJsonReport for doctor on a valid project',
    async () => {
      const projectRoot = await createValidProject('maa-mcp-doctor')
      const session = await startSession(projectRoot)
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'doctor',
        arguments: {},
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBeFalsy()
      expect(report).toMatchObject({
        schemaVersion: 1,
        tool: 'create-maa-project',
        command: 'doctor',
        ok: true,
        exitCode: 0,
        root: projectRoot,
      })
      expect(report.doctor?.lines.join('\n')).toContain('[OK] Project:')
      expect(report.pending).toEqual([])
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'keeps project roots isolated across multiple server instances',
    async () => {
      const firstRoot = await createValidProject('maa-mcp-first')
      const secondRoot = await createValidProject('maa-mcp-second')
      const firstSession = await startSession(firstRoot)
      const secondSession = await startSession(secondRoot)
      await Promise.all([initialize(firstSession), initialize(secondSession)])

      const response = await firstSession.request('tools/call', {
        name: 'sync',
        arguments: {
          target: 'display-name',
          value: 'First MCP Project',
        },
      })
      const { result, report } = parseToolReport(response)
      const firstConfig = JSON.parse(await readFile(join(firstRoot, 'maa-project.json'), 'utf8')) as {
        project: { displayName: string }
      }
      const secondConfig = JSON.parse(await readFile(join(secondRoot, 'maa-project.json'), 'utf8')) as {
        project: { displayName: string }
      }

      expect(result.isError).toBeFalsy()
      expect(report.root).toBe(firstRoot)
      expect(firstConfig.project.displayName).toBe('First MCP Project')
      expect(secondConfig.project.displayName).toBe('maa-mcp-second')
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'maintains a newly created child project through projectPath in the same session',
    async () => {
      const serverRoot = await tempRoot()
      const session = await startSession(serverRoot)
      await initialize(session)
      const projectPath = 'projects/maa-child'
      const projectRoot = join(serverRoot, 'projects', 'maa-child')

      const created = parseToolReport(
        await session.request('tools/call', {
          name: 'create_project',
          arguments: {
            name: projectPath,
            skipDownload: true,
            git: false,
          },
        }),
      )
      const synchronized = parseToolReport(
        await session.request('tools/call', {
          name: 'sync',
          arguments: {
            projectPath,
            target: 'display-name',
            value: 'Maintained Child',
          },
        }),
      )
      const added = parseToolReport(
        await session.request('tools/call', {
          name: 'add',
          arguments: {
            projectPath,
            addon: 'community',
          },
        }),
      )
      const diagnosed = parseToolReport(
        await session.request('tools/call', {
          name: 'doctor',
          arguments: { projectPath },
        }),
      )
      const cacheFile = join(projectRoot, '.create-maa-project', 'cache', 'asset.bin')
      await mkdir(dirname(cacheFile), { recursive: true })
      await writeFile(cacheFile, 'cached', 'utf8')
      const cleaned = parseToolReport(
        await session.request('tools/call', {
          name: 'clean_cache',
          arguments: { projectPath },
        }),
      )

      expect(created.result.isError).toBeFalsy()
      expect(created.report.root).toBe(projectRoot)
      expect(synchronized.result.isError).toBeFalsy()
      expect(synchronized.report.root).toBe(projectRoot)
      expect(added.result.isError).toBeFalsy()
      expect(added.report.root).toBe(projectRoot)
      expect(diagnosed.result.isError).toBeFalsy()
      expect(diagnosed.report.root).toBe(projectRoot)
      expect(diagnosed.report.doctor?.lines.join('\n')).toContain('[OK] Project: Maintained Child')
      expect(cleaned.result.isError).toBeFalsy()
      expect(cleaned.report).toMatchObject({
        command: 'clean-cache',
        root: projectRoot,
        written: [],
        removed: [
          '.create-maa-project/cache',
        ],
      })
      await expect(readFile(cacheFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(projectRoot, 'CONTRIBUTING.md'), 'utf8')).resolves.toContain('Maintained Child')
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'confines projectPath to real directories under the MCP server root',
    async () => {
      const serverRoot = await tempRoot()
      const outsideRoot = await tempRoot()
      await symlink(outsideRoot, join(serverRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      const session = await startSession(serverRoot)
      await initialize(session)

      for (const projectPath of [
        '../outside',
        outsideRoot,
        'escape',
      ]) {
        const { result, report } = parseToolReport(
          await session.request('tools/call', {
            name: 'doctor',
            arguments: { projectPath },
          }),
        )
        expect(result.isError, projectPath).toBe(true)
        expect(report.error?.message, projectPath).toContain('MCP server root')
      }
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'migrates legacy project config only through an explicit sync target',
    async () => {
      const root = await createValidProject('maa-mcp-migrate')
      const configPath = join(root, 'maa-project.json')
      const legacy = JSON.parse(await readFile(configPath, 'utf8')) as {
        schemaVersion: number
        maafw: { channel: string; version?: string }
        runtime: { mfa: { channel: string; version?: string; enabled: boolean } }
      }
      legacy.schemaVersion = 1
      legacy.maafw = { channel: 'v5.11.0-rc.1' }
      legacy.runtime.mfa = { channel: 'latest', enabled: true }
      await writeFile(configPath, `${JSON.stringify(legacy, null, 4)}\n`, 'utf8')
      const session = await startSession(root)
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'sync',
        arguments: { target: 'config' },
      })
      const { result, report } = parseToolReport(response)
      const migrated = JSON.parse(await readFile(configPath, 'utf8')) as {
        schemaVersion: number
        maafw: { channel: string; version?: string }
      }

      expect(result.isError).toBeFalsy()
      expect(report).toMatchObject({
        command: 'sync',
        ok: true,
        root,
        written: [
          'maa-project.json',
        ],
      })
      expect(report.backupId).toBeTruthy()
      expect(migrated).toMatchObject({
        schemaVersion: 2,
        maafw: { channel: 'beta', version: 'v5.11.0-rc.1' },
      })
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'returns doctor findings outside a project without treating them as MCP execution errors',
    async () => {
      const session = await startSession(await tempRoot())
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'doctor',
        arguments: {},
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBe(false)
      expect(report).toMatchObject({
        command: 'doctor',
        ok: false,
        exitCode: 1,
      })
      expect(report.error).toBeUndefined()
      expect(report.doctor?.lines.join('\n')).toContain('No maa-project.json found')
      expect(session.exitCode()).toBeNull()

      const listAfterError = await session.request('tools/list')
      expect(listAfterError.error).toBeUndefined()
      expect((listAfterError.result as ToolListResult).tools.length).toBeGreaterThan(0)
      expect(session.exitCode()).toBeNull()
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'preserves malformed config details in MCP doctor diagnostics',
    async () => {
      const root = await createValidProject('maa-mcp-invalid-config')
      await writeFile(join(root, 'maa-project.json'), '{ invalid', 'utf8')
      const session = await startSession(root)
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'doctor',
        arguments: {},
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBe(false)
      expect(report).toMatchObject({ command: 'doctor', ok: false, exitCode: 1 })
      expect(report.error).toBeUndefined()
      expect(report.doctor?.lines.join('\n')).toContain('[ERR] maa-project.json could not be read:')
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'rejects missing or inapplicable MCP sync values',
    async () => {
      const session = await startSession(await tempRoot())
      await initialize(session)

      const missingNetwork = await session.request('tools/call', {
        name: 'sync',
        arguments: { target: 'network' },
      })
      const missingNetworkReport = parseToolReport(missingNetwork)
      expect(missingNetworkReport.result.isError).toBe(true)
      expect(missingNetworkReport.report.error?.message).toContain('sync target "network" requires value')

      const extraMetadata = await session.request('tools/call', {
        name: 'sync',
        arguments: { target: 'metadata', value: 'ignored' },
      })
      const extraMetadataReport = parseToolReport(extraMetadata)
      expect(extraMetadataReport.result.isError).toBe(true)
      expect(extraMetadataReport.report.error?.message).toContain('sync target "metadata" does not accept value')
      expect(session.exitCode()).toBeNull()
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'rejects undeclared arguments for every MCP tool',
    async () => {
      const root = await tempRoot()
      const session = await startSession(root)
      await initialize(session)
      const calls = [
        { name: 'create_project', arguments: { name: 'must-not-exist', skipDownloads: true } },
        { name: 'doctor', arguments: { verbose: true } },
        { name: 'sync', arguments: { target: 'metadata', force: true } },
        { name: 'update', arguments: { targets: ['schema'], force: true } },
        { name: 'add', arguments: { addon: 'community', force: true } },
        { name: 'restore', arguments: { backupId: 'missing', force: true } },
        { name: 'clean_cache', arguments: { dryRun: true } },
      ]

      for (const call of calls) {
        const response = await session.request('tools/call', call)
        const { result, report } = parseToolReport(response)
        expect(result.isError, call.name).toBe(true)
        expect(report.error?.message, call.name).toContain(`Unknown argument for MCP tool ${call.name}:`)
      }
      await expect(readFile(join(root, 'must-not-exist', 'maa-project.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(session.exitCode()).toBeNull()
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'rejects update calls with an empty target list',
    async () => {
      const session = await startSession(await tempRoot())
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'update',
        arguments: {
          targets: [],
        },
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBe(true)
      expect(report).toMatchObject({
        command: 'update',
        ok: false,
        exitCode: 1,
      })
      expect(report.error?.message).toContain('targets must contain at least one item')
      expect(session.exitCode()).toBeNull()
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'accepts the shared runtime:mxu update target',
    async () => {
      const root = await createValidProject('maa-mcp-mxu')
      const session = await startSession(root)
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'update',
        arguments: {
          targets: [
            'runtime:mxu',
          ],
        },
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBeFalsy()
      expect(report).toMatchObject({
        command: 'update',
        ok: true,
        skipped: [
          'runtime:mxu (disabled in config)',
        ],
      })
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'rejects create_project resource-pack add-ons without a resourcePackSlug',
    async () => {
      const session = await startSession(await tempRoot())
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'create_project',
        arguments: {
          name: 'maa-mcp-resource-pack',
          add: [
            'resource-pack',
          ],
          skipDownload: true,
        },
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBe(true)
      expect(report).toMatchObject({
        command: 'create',
        ok: false,
        exitCode: 1,
      })
      expect(report.error?.message).toContain('resourcePackSlug is required')
      expect(session.exitCode()).toBeNull()
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'rejects incremental resource-pack add-ons without a resourcePackSlug',
    async () => {
      const session = await startSession(await tempRoot())
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'add',
        arguments: {
          addon: 'resource-pack',
        },
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBe(true)
      expect(report).toMatchObject({
        command: 'update',
        ok: false,
        exitCode: 1,
      })
      expect(report.error?.message).toContain('resourcePackSlug is required')
      expect(session.exitCode()).toBeNull()
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'reports a successful restore even when it removes the project configuration',
    async () => {
      const root = await createValidProject('maa-mcp-restore-created-project')
      let sourceBackupId: string | undefined
      for (const summary of await listProjectBackups(root)) {
        const inspection = await inspectProjectBackup(root, summary.id)
        if (inspection.entries.some((entry) => entry.path === 'maa-project.json' && entry.action === 'remove')) {
          sourceBackupId = summary.id
          break
        }
      }
      expect(sourceBackupId).toEqual(expect.any(String))
      const session = await startSession(root)
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'restore',
        arguments: { backupId: sourceBackupId },
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBeFalsy()
      expect(report).toMatchObject({
        command: 'backup',
        ok: true,
        backupScope: 'managed-files',
        backup: {
          operation: 'restore',
          backupId: sourceBackupId,
          restored: [],
          removed: expect.arrayContaining([
            'maa-project.json',
          ]),
          preRestoreBackupId: expect.any(String),
        },
      })
      expect(report.written).toEqual([])
      expect(report.removed).toEqual(expect.arrayContaining(['maa-project.json']))
      expect(report.backupId).toBe(report.backup?.preRestoreBackupId)
      await expect(readFile(join(root, 'maa-project.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'rejects a malformed restore source before creating a pre-restore backup',
    async () => {
      const root = await tempRoot()
      const backupsRoot = join(root, '.create-maa-project', 'backups')
      const backupRoot = join(backupsRoot, 'broken-backup')
      await mkdir(backupRoot, { recursive: true })
      await writeFile(join(backupRoot, '.create-maa-project-backup.json'), '{broken', 'utf8')
      const backupIdsBefore = (await readdir(backupsRoot)).sort()
      const session = await startSession(root)
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'restore',
        arguments: { backupId: 'broken-backup' },
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBe(true)
      expect(report.error?.message).toContain('malformed')
      expect((await readdir(backupsRoot)).sort()).toEqual(backupIdsBefore)
    },
    MCP_TEST_TIMEOUT_MS,
  )

  it(
    'returns an error report and keeps serving when the server cwd was deleted',
    async () => {
      const root = await tempRoot()
      const session = await startSession(root)
      await initialize(session)
      await rm(root, { recursive: true, force: true })

      const response = await session.request('tools/call', {
        name: 'doctor',
        arguments: {},
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBe(true)
      expect(report).toMatchObject({
        command: 'doctor',
        ok: false,
        exitCode: 1,
        root,
      })
      expect(report.error?.message).toEqual(expect.any(String))
      expect(session.exitCode()).toBeNull()

      const listAfterError = await session.request('tools/list')
      expect(listAfterError.error).toBeUndefined()
      expect((listAfterError.result as ToolListResult).tools.length).toBeGreaterThan(0)
      expect(session.exitCode()).toBeNull()
    },
    MCP_TEST_TIMEOUT_MS,
  )
})

async function createValidProject(name: string): Promise<string> {
  const root = await tempRoot()
  await execFileAsync(
    process.execPath,
    [
      distCli,
      name,
      '--skip-download',
      '--report',
    ],
    {
      cwd: root,
      env: testChildEnv(),
    },
  )
  const projectRoot = join(root, name)
  await writeFile(join(projectRoot, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\n", 'utf8')
  return projectRoot
}

async function startSession(cwd: string): Promise<McpSession> {
  const session = await McpSession.create(cwd)
  sessions.push(session)
  return session
}

async function initialize(session: McpSession): Promise<JsonRpcResponse> {
  const response = await session.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: {
      name: 'create-maa-project-vitest',
      version: '0.0.0',
    },
  })
  session.notify('notifications/initialized')
  return response
}

function toolByName(tools: ToolListResult['tools'], name: string): ToolListResult['tools'][number] {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(`Missing tool: ${name}`)
  return tool
}

function parseToolReport(response: JsonRpcResponse): {
  result: ToolCallResult
  report: JsonReport
} {
  expect(response.error).toBeUndefined()
  const result = response.result as ToolCallResult
  expect(result.content).toHaveLength(1)
  expect(result.content[0]).toMatchObject({
    type: 'text',
  })
  const text = result.content[0]?.text
  expect(text).toEqual(expect.any(String))
  return {
    result,
    report: JSON.parse(text as string) as JsonReport,
  }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-mcp-'))
  tempRoots.push(root)
  return root
}

class McpSession {
  private clientTransport: InMemoryTransport
  private nextId = 1
  private closed = false
  private exit: number | null = null
  private pending = new Map<
    number,
    {
      resolve: (response: JsonRpcResponse) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()

  private constructor(clientTransport: InMemoryTransport) {
    this.clientTransport = clientTransport
    this.clientTransport.onmessage = (message) => {
      this.handleMessage(message as JsonRpcResponse)
    }
    this.clientTransport.onerror = (error) => {
      this.failPending(error)
    }
    this.clientTransport.onclose = () => {
      this.exit = 0
      this.failPending(new Error('MCP transport closed before response.'))
    }
  }

  static async create(cwd: string): Promise<McpSession> {
    const [
      clientTransport,
      serverTransport,
    ] = InMemoryTransport.createLinkedPair()
    const server = createMcpServer(cwd)
    const session = new McpSession(clientTransport)
    await server.connect(serverTransport)
    await clientTransport.start()
    return session
  }

  request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId
    this.nextId += 1
    const payload = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out waiting for ${method}.`))
      }, 10000)
      this.pending.set(id, {
        resolve,
        reject,
        timer,
      })
    })
    void this.clientTransport.send(payload as JSONRPCMessage)
    return promise
  }

  notify(method: string, params?: unknown): void {
    const payload = params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
    void this.clientTransport.send(payload as JSONRPCMessage)
  }

  exitCode(): number | null {
    return this.exit
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.clientTransport.close()
  }

  private handleMessage(response: JsonRpcResponse): void {
    if (response.id === undefined) return
    const waiter = this.pending.get(response.id)
    if (!waiter) return
    this.pending.delete(response.id)
    clearTimeout(waiter.timer)
    waiter.resolve(response)
  }

  private failPending(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}
