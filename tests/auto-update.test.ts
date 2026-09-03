import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createMaaProjectConfigDirectory,
  runWithAutomaticUpdates,
  SKILL_NAME,
  SKILLS_CLI_VERSION,
} from '../src/auto-update.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
    }),
  )
})

async function temporaryConfigDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-updates-'))
  roots.push(root)
  return root
}

it('disabled automatic updates run the local CLI without network or subprocesses', async () => {
  const fetchLatestVersion = vi.fn<() => Promise<string | undefined>>()
  const runCommand = vi.fn()
  const runLocal = vi.fn(async () => 4)

  await expect(
    runWithAutomaticUpdates(['--version'], runLocal, {
      environment: { CREATE_MAA_PROJECT_AUTO_UPDATE: '0' },
      fetchLatestVersion,
      runCommand,
    }),
  ).resolves.toBe(4)
  expect(fetchLatestVersion).not.toHaveBeenCalled()
  expect(runCommand).not.toHaveBeenCalled()
  expect(runLocal).toHaveBeenCalledWith(['--version'])
})

it('CI disables automatic updates unless explicitly enabled', async () => {
  const fetchLatestVersion = vi.fn<() => Promise<string | undefined>>()
  const runCommand = vi.fn()
  const runLocal = vi.fn(async () => 0)

  await expect(
    runWithAutomaticUpdates(['my-project'], runLocal, {
      environment: { CI: 'true' },
      fetchLatestVersion,
      runCommand,
    }),
  ).resolves.toBe(0)
  expect(fetchLatestVersion).not.toHaveBeenCalled()
  expect(runCommand).not.toHaveBeenCalled()
})

it('a newer registry version receives the original command through an exact npm handoff', async () => {
  const directory = await temporaryConfigDirectory()
  const calls: Array<{ args: string[]; inheritStdio: boolean }> = []
  const runCommand = vi.fn(async (args: string[], options: { inheritStdio: boolean }) => {
    calls.push({ args, inheritStdio: options.inheritStdio })
    if (args.at(-1) === '--cli-version') {
      return { spawned: true, exitCode: 0, stdout: '0.2.0\n', stderr: '' }
    }
    return { spawned: true, exitCode: 7, stdout: '', stderr: '' }
  })
  const runSkillCommand = vi.fn(async (args: string[], options: { inheritStdio: boolean }) => {
    calls.push({ args, inheritStdio: options.inheritStdio })
    return { spawned: true, exitCode: 0, stdout: 'Already up to date.\n', stderr: '' }
  })
  const runLocal = vi.fn(async () => 0)

  await expect(
    runWithAutomaticUpdates(['my-project', '--report'], runLocal, {
      configDirectory: directory,
      currentVersion: '0.1.0',
      environment: {},
      fetchLatestVersion: async () => '0.2.0',
      now: () => new Date('2026-09-03T12:00:00.000Z'),
      runCommand,
      runSkillCommand,
    }),
  ).resolves.toBe(7)
  expect(runLocal).not.toHaveBeenCalled()
  expect(calls).toHaveLength(2)
  expect(calls[0]?.args).toContain('--package=create-maa-project@0.2.0')
  expect(calls[0]?.inheritStdio).toBe(false)
  expect(calls[1]?.args.slice(-2)).toEqual(['my-project', '--report'])
  expect(calls[1]?.inheritStdio).toBe(true)
  expect(runSkillCommand).not.toHaveBeenCalled()
})

it('the handed-off runtime skips a second registry check and synchronizes its Skill', async () => {
  const directory = await temporaryConfigDirectory()
  const fetchLatestVersion = vi.fn<() => Promise<string | undefined>>()
  const runSkillCommand = vi.fn(async () => ({
    spawned: true,
    exitCode: 0,
    stdout: 'Already up to date.\n',
    stderr: '',
  }))
  const runLocal = vi.fn(async () => 5)

  await expect(
    runWithAutomaticUpdates(['my-project'], runLocal, {
      configDirectory: directory,
      currentVersion: '0.2.0',
      environment: { CREATE_MAA_PROJECT_UPDATE_HANDOFF: '1' },
      fetchLatestVersion,
      runSkillCommand,
    }),
  ).resolves.toBe(5)
  expect(fetchLatestVersion).not.toHaveBeenCalled()
  expect(runSkillCommand).toHaveBeenCalledOnce()
})

it('the current runtime updates the managed global Skill once per version', async () => {
  const directory = await temporaryConfigDirectory()
  const environments: NodeJS.ProcessEnv[] = []
  const runSkillCommand = vi.fn(
    async (_args: string[], options: { environment: NodeJS.ProcessEnv; inheritStdio: boolean }) => {
      environments.push(options.environment)
      return {
        spawned: true,
        exitCode: 0,
        stdout: 'Already up to date.\n',
        stderr: '',
      }
    },
  )
  const fetchLatestVersion = vi.fn(async () => '0.1.0')
  const runLocal = vi.fn(async () => 0)
  const options = {
    configDirectory: directory,
    currentVersion: '0.1.0',
    environment: {},
    fetchLatestVersion,
    now: () => new Date('2026-09-03T12:00:00.000Z'),
    runSkillCommand,
  }

  await expect(runWithAutomaticUpdates(['--doctor', '--report'], runLocal, options)).resolves.toBe(0)
  await expect(runWithAutomaticUpdates(['--sync', 'version'], runLocal, options)).resolves.toBe(0)

  expect(fetchLatestVersion).toHaveBeenCalledTimes(1)
  expect(runSkillCommand).toHaveBeenCalledOnce()
  const commands = runSkillCommand.mock.calls.map(([args]) => args as string[])
  expect(commands[0]).toContain(`--package=skills@${SKILLS_CLI_VERSION}`)
  expect(commands[0]).toContain(SKILL_NAME)
  expect(commands[0]).toContain('--global')
  expect(environments.every((environment) => environment.DISABLE_TELEMETRY === '1')).toBe(true)
  const state = JSON.parse(await readFile(join(directory, 'updates.json'), 'utf8')) as Record<string, unknown>
  expect(state.latestVersion).toBe('0.1.0')
  expect(state.skillSyncVersion).toBe('0.1.0')
})

it('registry and Skill updater failures fall back to the local CLI', async () => {
  const directory = await temporaryConfigDirectory()
  const diagnostics: string[] = []
  const runSkillCommand = vi.fn(async () => ({
    spawned: false,
    exitCode: null,
    stdout: '',
    stderr: '',
  }))
  const runLocal = vi.fn(async () => 3)

  const options = {
    configDirectory: directory,
    currentVersion: '0.1.0',
    environment: {},
    fetchLatestVersion: async () => undefined,
    now: () => new Date('2026-09-03T12:00:00.000Z'),
    runSkillCommand,
    writeDiagnostic: (message: string) => diagnostics.push(message),
  }
  await expect(runWithAutomaticUpdates(['--doctor'], runLocal, options)).resolves.toBe(3)
  await expect(runWithAutomaticUpdates(['--doctor'], runLocal, options)).resolves.toBe(3)
  expect(runLocal).toHaveBeenCalledTimes(2)
  expect(runSkillCommand).toHaveBeenCalledOnce()
  expect(diagnostics.join('\n')).toContain('continuing with the installed Skill')
})

it('an active updater lock lets concurrent commands use the local runtime immediately', async () => {
  const directory = await temporaryConfigDirectory()
  await writeFile(join(directory, 'updates.lock'), 'another-process\n', 'utf8')
  const fetchLatestVersion = vi.fn<() => Promise<string | undefined>>()
  const runCommand = vi.fn()
  const runLocal = vi.fn(async () => 6)

  await expect(
    runWithAutomaticUpdates(['--doctor'], runLocal, {
      configDirectory: directory,
      environment: {},
      fetchLatestVersion,
      now: () => new Date(),
      runCommand,
    }),
  ).resolves.toBe(6)
  expect(fetchLatestVersion).not.toHaveBeenCalled()
  expect(runCommand).not.toHaveBeenCalled()
})

it('resolves config directory respecting environment overrides', () => {
  expect(createMaaProjectConfigDirectory({ CREATE_MAA_PROJECT_CONFIG_DIR: '/custom/dir' })).toBe(
    join(resolve('/custom/dir')),
  )
})
