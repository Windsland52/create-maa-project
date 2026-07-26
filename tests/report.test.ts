import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { withProjectLock } from '../src/project.js'
import { testChildEnv } from './child-env.js'

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
  removed: string[]
  skipped: string[]
  pending: Array<{ kind: string; reason: string; command: string }>
  suggestedCommands: Array<{ command: string; description: string; autoRun: boolean }>
  backupId?: string
  backupScope?: 'managed-files'
  backup?: {
    operation: string
    backups?: Array<{ id: string; entryCount: number; error?: string }>
    backup?: { id: string; entries: Array<{ path: string; action: string }> }
    restored?: string[]
    removed?: string[]
    preRestoreBackupId?: string
  }
  doctor?: { lines: string[] }
  error?: { message: string; code?: string }
}

type CliResult = {
  stdout: string
  stderr: string
  exitCode: number
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliEntry = join(repoRoot, 'dist/index.js')
const tempRoots: string[] = []
const CLI_TEST_TIMEOUT_MS = 20000

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('CLI JSON reports', () => {
  it(
    'only advertises log files that were actually created',
    async () => {
      const root = await tempRoot()
      const lazy = await runCli(['--clean-cache'], root)

      expect(lazy.exitCode).toBe(0)
      expect(lazy.stdout).toContain('Cleaned cache:')
      expect(lazy.stdout).not.toContain('Log:')
      await expect(readdir(join(root, '.create-maa-project', 'logs'))).rejects.toMatchObject({ code: 'ENOENT' })

      const explicitLog = join(root, 'explicit.log')
      const explicit = await runCli(
        [
          '--clean-cache',
          '--log-file',
          explicitLog,
        ],
        root,
      )
      expect(explicit.exitCode).toBe(0)
      expect(explicit.stdout).toContain(`Log: ${explicitLog}`)
      await expect(readFile(explicitLog, 'utf8')).resolves.toContain('argv=')
    },
    CLI_TEST_TIMEOUT_MS,
  )

  it(
    'requires an explicit target for non-interactive project creation',
    async () => {
      const reportRoot = await tempRoot()
      const reported = await runCli(['--skip-download', '--report'], reportRoot)
      const report = parseStdoutReport(reported.stdout, reported.stderr)

      expect(reported.exitCode).toBe(1)
      expect(report).toMatchObject({ command: 'create', ok: false, exitCode: 1 })
      expect(report.error?.message).toContain('requires an explicit target name or "."')
      await expect(readFile(join(reportRoot, 'maa-project.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

      const nonInteractiveRoot = await tempRoot()
      const nonInteractive = await runCli(['--skip-download', '--no-interactive'], nonInteractiveRoot)
      expect(nonInteractive.exitCode).toBe(1)
      expect(nonInteractive.stdout).toBe('')
      expect(nonInteractive.stderr).toContain('requires an explicit target name or "."')
      await expect(readFile(join(nonInteractiveRoot, 'maa-project.json'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })

      const explicitCurrentRoot = await tempRoot()
      const explicitCurrent = await runCli(['.', '--skip-download', '--report'], explicitCurrentRoot)
      const explicitCurrentReport = parseStdoutReport(explicitCurrent.stdout, explicitCurrent.stderr)
      expect(explicitCurrent.exitCode).toBe(0)
      expect(explicitCurrentReport).toMatchObject({ command: 'create', ok: true, root: explicitCurrentRoot })
      await expect(readFile(join(explicitCurrentRoot, 'maa-project.json'), 'utf8')).resolves.toContain(
        '"schemaVersion": 2',
      )
    },
    CLI_TEST_TIMEOUT_MS,
  )

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
          '--report',
        ],
        root,
      )
      const report = parseStdoutReport(result.stdout, result.stderr)

      expect(result.exitCode).toBe(0)
      expect(report).toMatchObject({
        command: 'create',
        ok: true,
        exitCode: 0,
        root: join(root, 'maa-report-create'),
        backupId: expect.any(String),
        backupScope: 'managed-files',
      })
      expect(report.pending).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: 'create-maa-project --update node-deps',
          }),
        ]),
      )
      expect(report.suggestedCommands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: 'create-maa-project --update node-deps',
            autoRun: false,
          }),
        ]),
      )
    },
    CLI_TEST_TIMEOUT_MS,
  )

  it(
    'lists, shows, and previews managed-files backups as JSON without changing the project',
    async () => {
      const root = await tempRoot()
      const created = await runCli(['maa-report-backup', '--skip-download', '--report'], root)
      const createReport = parseStdoutReport(created.stdout, created.stderr)
      const projectRoot = join(root, 'maa-report-backup')
      const backupId = createReport.backupId as string
      const readmeBefore = await readFile(join(projectRoot, 'README.md'), 'utf8')
      const backupRoot = join(projectRoot, '.create-maa-project', 'backups')
      const backupIdsBefore = (await readdir(backupRoot)).sort()

      const listed = await runCli(['--list-backups', '--report'], projectRoot)
      const listReport = parseStdoutReport(listed.stdout, listed.stderr)
      expect(listReport).toMatchObject({
        command: 'backup',
        ok: true,
        backup: {
          operation: 'list',
          backups: expect.arrayContaining([expect.objectContaining({ id: backupId })]),
        },
      })

      const shown = await runCli(['--show-backup', backupId, '--report'], projectRoot)
      const showReport = parseStdoutReport(shown.stdout, shown.stderr)
      expect(showReport.backup).toMatchObject({
        operation: 'show',
        backup: { id: backupId },
      })

      const previewed = await runCli(['--restore', backupId, '--dry-run', '--report'], projectRoot)
      const previewReport = parseStdoutReport(previewed.stdout, previewed.stderr)
      expect(previewReport).toMatchObject({
        command: 'backup',
        ok: true,
        written: [],
        backup: {
          operation: 'restore-preview',
          backup: {
            id: backupId,
            entries: expect.arrayContaining([expect.objectContaining({ path: 'README.md', action: 'remove' })]),
          },
        },
      })
      expect(await readFile(join(projectRoot, 'README.md'), 'utf8')).toBe(readmeBefore)
      expect((await readdir(backupRoot)).sort()).toEqual(backupIdsBefore)

      const synced = await runCli(['--sync', 'version', '--version', '0.2.0', '--report'], projectRoot)
      const syncReport = parseStdoutReport(synced.stdout, synced.stderr)
      const modifiedBackupId = syncReport.backupId as string
      const restoredModified = await runCli(['--restore', modifiedBackupId, '--report'], projectRoot)
      const restoredModifiedReport = parseStdoutReport(restoredModified.stdout, restoredModified.stderr)
      expect(restoredModifiedReport).toMatchObject({
        written: expect.arrayContaining([
          'maa-project.json',
        ]),
        removed: [],
        backup: {
          operation: 'restore',
          backupId: modifiedBackupId,
          restored: expect.arrayContaining([
            'maa-project.json',
          ]),
          removed: [],
        },
      })

      const restored = await runCli(['--restore', backupId, '--report'], projectRoot)
      const restoreReport = parseStdoutReport(restored.stdout, restored.stderr)
      expect(restored.exitCode).toBe(0)
      expect(restoreReport).toMatchObject({
        command: 'backup',
        ok: true,
        backupId: expect.any(String),
        backupScope: 'managed-files',
        backup: {
          operation: 'restore',
          backupId,
          restored: [],
          removed: expect.arrayContaining([
            'README.md',
          ]),
          preRestoreBackupId: expect.any(String),
        },
      })
      expect(restoreReport.written).toEqual([])
      expect(restoreReport.removed).toEqual(expect.arrayContaining(['README.md']))
      expect(restoreReport.backupId).not.toBe(backupId)
      await expect(readFile(join(projectRoot, 'README.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    },
    CLI_TEST_TIMEOUT_MS,
  )

  it(
    'does not list backups concurrently with an active project operation',
    async () => {
      const root = await tempRoot()

      await withProjectLock(root, 'hold backup list', async () => {
        const listed = await runCli(['--list-backups', '--report'], root)
        const report = parseStdoutReport(listed.stdout, listed.stderr)
        expect(listed.exitCode).toBe(1)
        expect(report).toMatchObject({ command: 'backup', ok: false, exitCode: 1 })
        expect(report.error?.message).toContain('Another create-maa-project command is running')
      })
    },
    CLI_TEST_TIMEOUT_MS,
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
          '--report',
        ],
        projectRoot,
      )
      const report = parseStdoutReport(result.stdout, result.stderr)

      expect(result.exitCode).toBe(0)
      expect(report).toMatchObject({
        command: 'sync',
        ok: true,
        exitCode: 0,
        root: projectRoot,
        logPath: null,
      })
      expect(report.written).toEqual(
        expect.arrayContaining([
          'interface.json',
          'maa-project.json',
        ]),
      )
    },
    CLI_TEST_TIMEOUT_MS,
  )

  it(
    'reports update as pure stdout JSON',
    async () => {
      const projectRoot = await createReportProject('maa-report-update')
      const result = await runCli(
        [
          '--update',
          'schema',
          '--report',
        ],
        projectRoot,
      )
      const report = parseStdoutReport(result.stdout, result.stderr)

      expect(result.exitCode).toBe(0)
      expect(report).toMatchObject({
        command: 'update',
        ok: true,
        exitCode: 0,
        root: projectRoot,
        logPath: null,
      })
      expect(report.written).toEqual(
        expect.arrayContaining([
          'maa-project.json',
          'tools/schema/interface.schema.json',
        ]),
      )
    },
    CLI_TEST_TIMEOUT_MS,
  )

  it(
    'reports doctor failures as pure stdout JSON',
    async () => {
      const projectRoot = await createReportProject('maa-report-doctor')
      const checkProjectPath = join(projectRoot, 'tools/check-project.mjs')
      await rm(checkProjectPath)

      const result = await runCli(
        [
          '--doctor',
          '--report',
        ],
        projectRoot,
      )
      const report = parseStdoutReport(result.stdout, result.stderr)

      expect(result.exitCode).toBe(1)
      expect(report).toMatchObject({
        command: 'doctor',
        ok: false,
        exitCode: 1,
        root: projectRoot,
      })
      expect(report.doctor?.lines.join('\n')).toContain('Required project file is missing: tools/check-project.mjs')
    },
    CLI_TEST_TIMEOUT_MS,
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
          '1.0.0-alpha..1',
          '--report',
        ],
        projectRoot,
      )
      const report = parseStdoutReport(result.stdout, result.stderr)

      expect(result.exitCode).toBe(1)
      expect(report).toMatchObject({
        command: 'sync',
        ok: false,
        exitCode: 1,
        root: projectRoot,
      })
      expect(report.error?.message).toContain('Invalid version')
    },
    CLI_TEST_TIMEOUT_MS,
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
      '--report',
    ],
    root,
  )
  expect(result.exitCode, result.stderr).toBe(0)
  parseStdoutReport(result.stdout, result.stderr)
  return join(root, name)
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-report-'))
  tempRoots.push(root)
  return root
}

async function runCli(args: string[], cwd: string): Promise<CliResult> {
  const ioRoot = await mkdtemp(join(tmpdir(), 'cmp-report-io-'))
  tempRoots.push(ioRoot)
  const stdoutPath = join(ioRoot, 'stdout.txt')
  const stderrPath = join(ioRoot, 'stderr.txt')
  const stdout = await open(stdoutPath, 'w')
  const stderr = await open(stderrPath, 'w')
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    const child = spawn(
      process.execPath,
      [
        cliEntry,
        ...args,
      ],
      {
        cwd,
        env: testChildEnv(),
        stdio: [
          'ignore',
          stdout.fd,
          stderr.fd,
        ],
      },
    )
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 15000)
    const finish = async (action: () => Promise<void>): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      await Promise.all([
        stdout.close(),
        stderr.close(),
      ])
      await action()
    }
    child.on('error', (error) => {
      void finish(async () => {
        reject(error)
      })
    })
    child.on('exit', (code, signal) => {
      void finish(async () => {
        if (timedOut) {
          reject(new Error(`CLI timed out while running: ${args.join(' ')}`))
          return
        }
        resolve({
          stdout: await readFile(stdoutPath, 'utf8'),
          stderr: await readFile(stderrPath, 'utf8'),
          exitCode: code ?? (signal ? 1 : 0),
        })
      })
    })
  })
}

function parseStdoutReport(stdout: string, stderr: string): JsonReport {
  expect(stdout, stderr).not.toBe('')
  expect(stdout, stderr).not.toContain('Log:')
  expect(stdout, stderr).not.toContain('Error:')
  expect(stdout, stderr).not.toContain('Downloading OCR')
  expect(stdout, stderr).not.toContain('Written files:')
  let parsed: unknown
  expect(() => {
    parsed = JSON.parse(stdout)
  }).not.toThrow()
  expect(parsed).toMatchObject({
    schemaVersion: 1,
    tool: 'create-maa-project',
  })
  const report = parsed as JsonReport
  expect(report.timestamp).toEqual(expect.any(String))
  expect(report.durationMs).toEqual(expect.any(Number))
  expect(report.executionId).toEqual(expect.any(String))
  expect(report.logPath === null || typeof report.logPath === 'string').toBe(true)
  return report
}
