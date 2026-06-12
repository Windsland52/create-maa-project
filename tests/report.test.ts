import { execFile, type ExecFileException } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

type JsonReport = {
  schemaVersion: 1
  tool: 'create-maa-project'
  command: string
  ok: boolean
  timestamp: string
  durationMs: number
  exitCode: number
  executionId: string
  root: string
  logPath: string | null
  written: string[]
  skipped: string[]
  pending: Array<{ kind: string; reason: string; command: string }>
  changedManagedFiles: Array<{ path: string; status: string }>
  changedUserFiles: Array<{ path: string; status: string }>
  suggestedCommands: Array<{ command: string; description: string; autoRun: boolean }>
  doctor?: { lines: string[] }
  diff?: { lines: string[] }
  error?: { message: string; code?: string }
}

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

const require = createRequire(import.meta.url)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const tsxCli = require.resolve('tsx/cli')
const cliEntry = join(repoRoot, 'src/index.ts')
const tempRoots: string[] = []
const CLI_TEST_TIMEOUT_MS = 20000

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('CLI JSON reports', () => {
  it(
    'reports create as pure stdout JSON',
    async () => {
      const root = await tempRoot()
      const result = await runCli(
        [
          'maa-report-create',
          '--add',
          'dev-tools',
          '--skip-download',
          '--report'
        ],
        root
      )
      const report = parseStdoutReport(result.stdout)

      expect(result.exitCode).toBe(0)
      expect(report).toMatchObject({
        command: 'create',
        ok: true,
        exitCode: 0,
        root: join(root, 'maa-report-create')
      })
      expect(report.pending).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: 'create-maa-project --update node-deps'
          })
        ])
      )
      expect(report.suggestedCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: 'create-maa-project --update node-deps',
            autoRun: false
          })
        ])
      )
    },
    CLI_TEST_TIMEOUT_MS
  )

  it(
    'reports sync as pure stdout JSON',
    async () => {
      const projectRoot = await createReportProject('maa-report-sync')
      const result = await runCli(
        [
          '--sync',
          'version',
          '--version',
          '0.2.0',
          '--report'
        ],
        projectRoot
      )
      const report = parseStdoutReport(result.stdout)

      expect(result.exitCode).toBe(0)
      expect(report).toMatchObject({
        command: 'sync',
        ok: true,
        exitCode: 0,
        root: projectRoot
      })
      expect(report.written).toEqual(
        expect.arrayContaining([
          'interface.json',
          'maa-project.json'
        ])
      )
    },
    CLI_TEST_TIMEOUT_MS
  )

  it(
    'reports update as pure stdout JSON',
    async () => {
      const projectRoot = await createReportProject('maa-report-update')
      const result = await runCli(
        [
          '--update',
          'schema',
          '--report'
        ],
        projectRoot
      )
      const report = parseStdoutReport(result.stdout)

      expect(result.exitCode).toBe(0)
      expect(report).toMatchObject({
        command: 'update',
        ok: true,
        exitCode: 0,
        root: projectRoot
      })
      expect(report.written).toEqual(
        expect.arrayContaining([
          'maa-project.json',
          'maa-project.lock.json'
        ])
      )
    },
    CLI_TEST_TIMEOUT_MS
  )

  it(
    'reports diff as pure stdout JSON with managed file status',
    async () => {
      const projectRoot = await createReportProject('maa-report-diff')
      const checkProjectPath = join(projectRoot, 'tools/check-project.mjs')
      await writeFile(
        checkProjectPath,
        `${await readFile(checkProjectPath, 'utf8')}\nconsole.log('local report diff')\n`,
        'utf8'
      )

      const result = await runCli(
        [
          '--diff',
          '--report'
        ],
        projectRoot
      )
      const report = parseStdoutReport(result.stdout)

      expect(result.exitCode).toBe(0)
      expect(report).toMatchObject({
        command: 'diff',
        ok: true,
        exitCode: 0,
        root: projectRoot
      })
      expect(report.changedManagedFiles).toEqual([
        {
          path: 'tools/check-project.mjs',
          status: 'modified'
        }
      ])
      expect(report.diff?.lines?.join('\n')).toContain('local report diff')
    },
    CLI_TEST_TIMEOUT_MS
  )

  it(
    'reports doctor failures as pure stdout JSON',
    async () => {
      const projectRoot = await createReportProject('maa-report-doctor')
      const checkProjectPath = join(projectRoot, 'tools/check-project.mjs')
      await writeFile(
        checkProjectPath,
        `${await readFile(checkProjectPath, 'utf8')}\nconsole.log('local report doctor')\n`,
        'utf8'
      )

      const result = await runCli(
        [
          '--doctor',
          '--report'
        ],
        projectRoot
      )
      const report = parseStdoutReport(result.stdout)

      expect(result.exitCode).toBe(1)
      expect(report).toMatchObject({
        command: 'doctor',
        ok: false,
        exitCode: 1,
        root: projectRoot
      })
      expect(report.changedManagedFiles).toEqual([
        {
          path: 'tools/check-project.mjs',
          status: 'modified'
        }
      ])
      expect(report.suggestedCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: 'create-maa-project --accept-changes tools/check-project.mjs'
          })
        ])
      )
    },
    CLI_TEST_TIMEOUT_MS
  )

  it(
    'reports command errors as pure stdout JSON',
    async () => {
      const projectRoot = await createReportProject('maa-report-error')
      const result = await runCli(
        [
          '--sync',
          'version',
          '--version',
          'not-semver',
          '--report'
        ],
        projectRoot
      )
      const report = parseStdoutReport(result.stdout)

      expect(result.exitCode).toBe(1)
      expect(report).toMatchObject({
        command: 'sync',
        ok: false,
        exitCode: 1,
        root: projectRoot
      })
      expect(report.error?.message).toContain('Invalid version')
    },
    CLI_TEST_TIMEOUT_MS
  )
})

async function createReportProject(name: string): Promise<string> {
  const root = await tempRoot()
  const result = await runCli(
    [
      name,
      '--add',
      'dev-tools',
      '--skip-download',
      '--report'
    ],
    root
  )
  expect(result.exitCode).toBe(0)
  parseStdoutReport(result.stdout)
  return join(root, name)
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-report-'))
  tempRoots.push(root)
  return root
}

async function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        tsxCli,
        cliEntry,
        ...args
      ],
      {
        cwd,
        timeout: 15000,
        env: {
          ...process.env,
          CREATE_MAA_PROJECT_DOWNLOAD_ATTEMPTS: '1'
        }
      },
      (error, stdout, stderr) => {
        const execError = error as ExecFileException | null
        if (execError?.killed) {
          reject(new Error(`CLI timed out while running: ${args.join(' ')}`))
          return
        }
        const code = execError?.code
        resolve({
          stdout,
          stderr,
          exitCode: typeof code === 'number' ? code : error ? 1 : 0
        })
      }
    )
  })
}

function parseStdoutReport(stdout: string): JsonReport {
  expect(stdout).not.toBe('')
  expect(stdout).not.toContain('Log:')
  expect(stdout).not.toContain('Error:')
  expect(stdout).not.toContain('Downloading OCR')
  expect(stdout).not.toContain('Written files:')
  let parsed: unknown
  expect(() => {
    parsed = JSON.parse(stdout)
  }).not.toThrow()
  expect(parsed).toMatchObject({
    schemaVersion: 1,
    tool: 'create-maa-project'
  })
  const report = parsed as JsonReport
  expect(report.timestamp).toEqual(expect.any(String))
  expect(report.durationMs).toEqual(expect.any(Number))
  expect(report.executionId).toEqual(expect.any(String))
  expect(report.logPath === null || typeof report.logPath === 'string').toBe(true)
  expect(report.changedUserFiles).toEqual([])
  return report
}
