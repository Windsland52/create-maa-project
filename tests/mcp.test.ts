import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

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
  changedManagedFiles: Array<{ path: string; status: string }>
  changedUserFiles: Array<{ path: string; status: string }>
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
    'responds to initialize over stdio',
    async () => {
      const session = await startSession(await tempRoot())
      const response = await initialize(session)

      expect(response.error).toBeUndefined()
      expect(response.result).toMatchObject({
        serverInfo: {
          name: 'create-maa-project',
          version: '0.1.0'
        },
        capabilities: {
          tools: {}
        }
      })
    },
    MCP_TEST_TIMEOUT_MS
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
        'diff',
        'sync',
        'update',
        'add',
        'accept_changes',
        'restore',
        'clean_cache'
      ])
      expect(toolByName(tools, 'create_project').inputSchema.required).toEqual([
        'name'
      ])
      expect(toolByName(tools, 'sync').inputSchema.required).toEqual([
        'target'
      ])
      expect(toolByName(tools, 'update').inputSchema.required).toEqual([
        'targets'
      ])
      expect(toolByName(tools, 'add').inputSchema.properties?.addon).toMatchObject({
        enum: expect.arrayContaining([
          'dev-tools',
          'resource-pack',
          'schema-sync'
        ])
      })
    },
    MCP_TEST_TIMEOUT_MS
  )

  it(
    'returns a successful CliJsonReport for doctor on a valid project',
    async () => {
      const projectRoot = await createValidProject('maa-mcp-doctor')
      const session = await startSession(projectRoot)
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'doctor',
        arguments: {}
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBeFalsy()
      expect(report).toMatchObject({
        schemaVersion: 1,
        tool: 'create-maa-project',
        command: 'doctor',
        ok: true,
        exitCode: 0,
        root: projectRoot
      })
      expect(report.doctor?.lines.join('\n')).toContain('[OK] Project:')
      expect(report.pending).toEqual([])
      expect(report.changedUserFiles).toEqual([])
    },
    MCP_TEST_TIMEOUT_MS
  )

  it(
    'returns an error report for doctor outside a project and keeps serving requests',
    async () => {
      const session = await startSession(await tempRoot())
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'doctor',
        arguments: {}
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBe(true)
      expect(report).toMatchObject({
        command: 'doctor',
        ok: false,
        exitCode: 1
      })
      expect(report.error?.message).toContain('No maa-project.json found')
      expect(session.exitCode()).toBeNull()

      const listAfterError = await session.request('tools/list')
      expect(listAfterError.error).toBeUndefined()
      expect((listAfterError.result as ToolListResult).tools.length).toBeGreaterThan(0)
      expect(session.exitCode()).toBeNull()
    },
    MCP_TEST_TIMEOUT_MS
  )

  it(
    'rejects update calls with an empty target list',
    async () => {
      const session = await startSession(await tempRoot())
      await initialize(session)

      const response = await session.request('tools/call', {
        name: 'update',
        arguments: {
          targets: []
        }
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBe(true)
      expect(report).toMatchObject({
        command: 'update',
        ok: false,
        exitCode: 1
      })
      expect(report.error?.message).toContain('targets must contain at least one item')
      expect(session.exitCode()).toBeNull()
    },
    MCP_TEST_TIMEOUT_MS
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
        arguments: {}
      })
      const { result, report } = parseToolReport(response)

      expect(result.isError).toBe(true)
      expect(report).toMatchObject({
        command: 'doctor',
        ok: false,
        exitCode: 1,
        root
      })
      expect(report.error?.message).toEqual(expect.any(String))
      expect(session.exitCode()).toBeNull()

      const listAfterError = await session.request('tools/list')
      expect(listAfterError.error).toBeUndefined()
      expect((listAfterError.result as ToolListResult).tools.length).toBeGreaterThan(0)
      expect(session.exitCode()).toBeNull()
    },
    MCP_TEST_TIMEOUT_MS
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
      '--report'
    ],
    {
      cwd: root,
      env: testChildEnv()
    }
  )
  const projectRoot = join(root, name)
  const lockPath = join(projectRoot, 'maa-project.lock.json')
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as { pending?: unknown[] }
  lock.pending = []
  await writeFile(lockPath, `${JSON.stringify(lock, null, 4)}\n`, 'utf8')
  return projectRoot
}

async function startSession(cwd: string): Promise<McpSession> {
  const session = new McpSession(cwd)
  sessions.push(session)
  return session
}

async function initialize(session: McpSession): Promise<JsonRpcResponse> {
  const response = await session.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: {
      name: 'create-maa-project-vitest',
      version: '0.0.0'
    }
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
    type: 'text'
  })
  const text = result.content[0]?.text
  expect(text).toEqual(expect.any(String))
  return {
    result,
    report: JSON.parse(text as string) as JsonReport
  }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-mcp-'))
  tempRoots.push(root)
  return root
}

class McpSession {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private stdoutBuffer = ''
  private stderrText = ''
  private pending = new Map<
    number,
    {
      resolve: (response: JsonRpcResponse) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()

  constructor(cwd: string) {
    this.child = spawn(
      process.execPath,
      [
        distCli,
        '--mcp'
      ],
      {
        cwd,
        env: testChildEnv(),
        stdio: [
          'pipe',
          'pipe',
          'pipe'
        ]
      }
    )
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.handleStdout(chunk)
    })
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrText += chunk
    })
    this.child.on('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      for (const [
        id,
        waiter
      ] of this.pending) {
        clearTimeout(waiter.timer)
        waiter.reject(
          new Error(
            `MCP server exited before response ${id} (${suffix}). stderr=${JSON.stringify(
              this.stderrText
            )}`
          )
        )
      }
      this.pending.clear()
    })
  }

  request(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId
    this.nextId += 1
    const payload =
      params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }
    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(`Timed out waiting for ${method}. stderr=${JSON.stringify(this.stderrText)}`)
        )
      }, 10000)
      this.pending.set(id, {
        resolve,
        reject,
        timer
      })
    })
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
    return promise
  }

  notify(method: string, params?: unknown): void {
    const payload =
      params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  exitCode(): number | null {
    return this.child.exitCode
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return
    this.child.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill()
        resolve()
      }, 1000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      let response: JsonRpcResponse
      try {
        response = JSON.parse(line) as JsonRpcResponse
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.failPending(
          new Error(
            `MCP server wrote invalid JSON to stdout: ${JSON.stringify(
              line
            )}. ${message}. stderr=${JSON.stringify(this.stderrText)}`
          )
        )
        return
      }
      const waiter = this.pending.get(response.id)
      if (!waiter) continue
      this.pending.delete(response.id)
      clearTimeout(waiter.timer)
      waiter.resolve(response)
    }
  }

  private failPending(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}

function testChildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS: '1'
  }
}
