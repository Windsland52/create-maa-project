import { mkdir, open, readFile, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { isSemVerGreaterThan, isStableSemVer } from './semver.js'
import { CLI_VERSION } from './version.js'

export const UPDATE_STATE_SCHEMA_VERSION = 'create-maa-project-updates/v1' as const
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_REQUEST_TIMEOUT_MS = 1500
export const UPDATE_LOCK_STALE_MS = 10 * 60 * 1000
export const UPDATE_SUBPROCESS_TIMEOUT_MS = 2 * 60 * 1000
export const CAPTURE_LIMIT_CHARACTERS = 64 * 1024
export const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/create-maa-project/latest'
export const SKILLS_CLI_VERSION = '1.5.22'
export const HANDOFF_ENVIRONMENT_KEY = 'CREATE_MAA_PROJECT_UPDATE_HANDOFF'
export const PROBE_ENVIRONMENT_KEY = 'CREATE_MAA_PROJECT_UPDATE_PROBE'
export const SKILL_NAME = 'create-maa-project'

export type UpdateState = {
  schemaVersion: typeof UPDATE_STATE_SCHEMA_VERSION
  checkedAt?: string
  latestVersion?: string
  skillSyncVersion?: string
  skillSyncAttemptedAt?: string
  skillSyncAttemptedVersion?: string
}

export type CommandOptions = {
  environment: NodeJS.ProcessEnv
  inheritStdio: boolean
  timeoutMs?: number
}

export type CommandResult = {
  spawned: boolean
  exitCode: number | null
  stdout: string
  stderr: string
}

export type AutoUpdateDependencies = {
  configDirectory?: string
  currentVersion?: string
  environment?: NodeJS.ProcessEnv
  fetchLatestVersion?: () => Promise<string | undefined>
  now?: () => Date
  runCommand?: (args: string[], options: CommandOptions) => Promise<CommandResult>
  runSkillCommand?: (args: string[], options: CommandOptions) => Promise<CommandResult>
  writeDiagnostic?: (message: string) => void
}

export function createMaaProjectConfigDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.CREATE_MAA_PROJECT_CONFIG_DIR !== undefined) {
    return resolve(environment.CREATE_MAA_PROJECT_CONFIG_DIR)
  }
  if (process.platform === 'win32' && environment.LOCALAPPDATA !== undefined) {
    return join(environment.LOCALAPPDATA, 'create-maa-project')
  }
  if (environment.XDG_CONFIG_HOME !== undefined) {
    return join(environment.XDG_CONFIG_HOME, 'create-maa-project')
  }
  return join(homedir(), '.config', 'create-maa-project')
}

function updateStatePath(directory: string): string {
  return join(directory, 'updates.json')
}

function updateLockPath(directory: string): string {
  return join(directory, 'updates.lock')
}

async function acquireUpdateLock(directory: string, now: Date): Promise<(() => Promise<void>) | undefined> {
  await mkdir(directory, { recursive: true }).catch(() => undefined)
  const lockPath = updateLockPath(directory)
  let handle: FileHandle
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return undefined
    try {
      const lockStat = await stat(lockPath)
      if (now.getTime() - lockStat.mtimeMs < UPDATE_LOCK_STALE_MS) return undefined
      await unlink(lockPath)
      handle = await open(lockPath, 'wx', 0o600)
    } catch {
      return undefined
    }
  }
  await handle.writeFile(`${process.pid}\n`, 'utf8').catch(() => undefined)
  let released = false
  return async () => {
    if (released) return
    released = true
    await handle.close().catch(() => undefined)
    await unlink(lockPath).catch(() => undefined)
  }
}

async function readUpdateState(directory: string): Promise<UpdateState> {
  try {
    const value: unknown = JSON.parse(await readFile(updateStatePath(directory), 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { schemaVersion: UPDATE_STATE_SCHEMA_VERSION }
    }
    const record = value as Record<string, unknown>
    if (record.schemaVersion !== UPDATE_STATE_SCHEMA_VERSION) {
      return { schemaVersion: UPDATE_STATE_SCHEMA_VERSION }
    }
    return {
      schemaVersion: UPDATE_STATE_SCHEMA_VERSION,
      ...(typeof record.checkedAt === 'string' ? { checkedAt: record.checkedAt } : {}),
      ...(typeof record.latestVersion === 'string' ? { latestVersion: record.latestVersion } : {}),
      ...(typeof record.skillSyncVersion === 'string' ? { skillSyncVersion: record.skillSyncVersion } : {}),
      ...(typeof record.skillSyncAttemptedAt === 'string' ? { skillSyncAttemptedAt: record.skillSyncAttemptedAt } : {}),
      ...(typeof record.skillSyncAttemptedVersion === 'string'
        ? { skillSyncAttemptedVersion: record.skillSyncAttemptedVersion }
        : {}),
    }
  } catch {
    return { schemaVersion: UPDATE_STATE_SCHEMA_VERSION }
  }
}

async function writeUpdateState(directory: string, state: UpdateState): Promise<void> {
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(updateStatePath(directory), `${JSON.stringify(state, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch {
    // Update bookkeeping must never block CLI execution.
  }
}

function fresh(timestamp: string | undefined, now: Date): boolean {
  if (timestamp === undefined) return false
  const checkedAt = Date.parse(timestamp)
  const age = now.getTime() - checkedAt
  return Number.isFinite(checkedAt) && age >= 0 && age < UPDATE_CHECK_INTERVAL_MS
}

async function fetchLatestStableVersion(): Promise<string | undefined> {
  try {
    const response = await fetch(REGISTRY_LATEST_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const version = (value as Record<string, unknown>).version
    return isStableSemVer(version) ? version : undefined
  } catch {
    return undefined
  }
}

async function runProgram(executable: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout: NodeJS.Timeout | undefined
    const child = spawn(executable, args, {
      env: options.environment,
      shell: process.platform === 'win32',
      stdio: options.inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString().slice(0, CAPTURE_LIMIT_CHARACTERS - stdout.length)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString().slice(0, CAPTURE_LIMIT_CHARACTERS - stderr.length)
    })
    child.once('error', () => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      resolve({ spawned: false, exitCode: null, stdout, stderr })
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      resolve({ spawned: true, exitCode, stdout, stderr })
    })
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => child.kill(), options.timeoutMs)
      timeout.unref()
    }
  })
}

async function runNpm(args: string[], options: CommandOptions): Promise<CommandResult> {
  return runProgram('npm', args, options)
}

function npmExec(packageSpecification: string, executable: string, args: string[]): string[] {
  return ['exec', '--yes', `--package=${packageSpecification}`, '--', executable, ...args]
}

function updatesEnabled(args: string[], environment: NodeJS.ProcessEnv): boolean {
  if (environment[PROBE_ENVIRONMENT_KEY] === '1') return false
  if (environment.CREATE_MAA_PROJECT_AUTO_UPDATE === '0') return false
  if (environment.CI !== undefined && environment.CREATE_MAA_PROJECT_AUTO_UPDATE !== '1') return false
  if (
    args.length === 0 ||
    args.includes('--help') ||
    args.includes('-h') ||
    args.includes('--cli-version') ||
    args.includes('-V')
  ) {
    return false
  }
  return true
}

async function latestVersion(
  state: UpdateState,
  directory: string,
  now: Date,
  fetchVersion: () => Promise<string | undefined>,
): Promise<{ latest: string | undefined; state: UpdateState }> {
  if (fresh(state.checkedAt, now)) {
    return {
      latest: isStableSemVer(state.latestVersion) ? state.latestVersion : undefined,
      state,
    }
  }
  const resolved = await fetchVersion()
  const nextState: UpdateState = {
    ...state,
    checkedAt: now.toISOString(),
    ...(resolved === undefined ? {} : { latestVersion: resolved }),
  }
  await writeUpdateState(directory, nextState)
  return {
    latest: resolved ?? (isStableSemVer(state.latestVersion) ? state.latestVersion : undefined),
    state: nextState,
  }
}

async function synchronizeSkill(
  state: UpdateState,
  directory: string,
  currentVersion: string,
  now: Date,
  environment: NodeJS.ProcessEnv,
  command: (args: string[], options: CommandOptions) => Promise<CommandResult>,
  diagnostic: (message: string) => void,
): Promise<void> {
  if (state.skillSyncVersion === currentVersion) return
  if (state.skillSyncAttemptedVersion === currentVersion && fresh(state.skillSyncAttemptedAt, now)) {
    return
  }

  const attemptedState: UpdateState = {
    ...state,
    skillSyncAttemptedAt: now.toISOString(),
    skillSyncAttemptedVersion: currentVersion,
  }
  await writeUpdateState(directory, attemptedState)
  const skillsEnvironment = { ...environment, DISABLE_TELEMETRY: '1' }
  const result = await command(
    npmExec(`skills@${SKILLS_CLI_VERSION}`, 'skills', [
      'update',
      SKILL_NAME,
      '--global',
      '--yes',
    ]),
    {
      environment: skillsEnvironment,
      inheritStdio: false,
      timeoutMs: UPDATE_SUBPROCESS_TIMEOUT_MS,
    },
  )
  if (!result.spawned || result.exitCode !== 0) {
    diagnostic('create-maa-project: automatic global Skill update failed; continuing with the installed Skill.\n')
    return
  }
  await writeUpdateState(directory, {
    ...attemptedState,
    skillSyncVersion: currentVersion,
  })
}

async function probeVersion(
  version: string,
  environment: NodeJS.ProcessEnv,
  command: (args: string[], options: CommandOptions) => Promise<CommandResult>,
): Promise<boolean> {
  const packageSpecification = `create-maa-project@${version}`
  const probeEnvironment = { ...environment, [PROBE_ENVIRONMENT_KEY]: '1' }
  const probe = await command(npmExec(packageSpecification, 'create-maa-project', ['--cli-version']), {
    environment: probeEnvironment,
    inheritStdio: false,
    timeoutMs: UPDATE_SUBPROCESS_TIMEOUT_MS,
  })
  return probe.spawned && probe.exitCode === 0 && probe.stdout.trim() === version
}

async function handOffToVersion(
  version: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  command: (args: string[], options: CommandOptions) => Promise<CommandResult>,
): Promise<number | undefined> {
  const packageSpecification = `create-maa-project@${version}`
  const handoffEnvironment = { ...environment, [HANDOFF_ENVIRONMENT_KEY]: '1' }
  const handoff = await command(npmExec(packageSpecification, 'create-maa-project', args), {
    environment: handoffEnvironment,
    inheritStdio: true,
  })
  if (!handoff.spawned) return undefined
  return handoff.exitCode ?? 1
}

export async function runWithAutomaticUpdates(
  args: string[],
  runLocal: (args: string[]) => Promise<number>,
  dependencies: AutoUpdateDependencies = {},
): Promise<number> {
  const environment = dependencies.environment ?? process.env
  if (!updatesEnabled(args, environment)) return runLocal(args)

  const currentVersion = dependencies.currentVersion ?? CLI_VERSION
  const now = (dependencies.now ?? (() => new Date()))()
  const directory = dependencies.configDirectory ?? createMaaProjectConfigDirectory(environment)
  const command = dependencies.runCommand ?? runNpm
  const skillCommand = dependencies.runSkillCommand ?? runNpm
  const diagnostic = dependencies.writeDiagnostic ?? ((message: string) => process.stderr.write(message))
  const releaseLock = await acquireUpdateLock(directory, now)
  if (releaseLock === undefined) return runLocal(args)

  try {
    let state = await readUpdateState(directory)
    if (environment[HANDOFF_ENVIRONMENT_KEY] !== '1') {
      const resolved = await latestVersion(
        state,
        directory,
        now,
        dependencies.fetchLatestVersion ?? fetchLatestStableVersion,
      )
      state = resolved.state
      if (
        resolved.latest !== undefined &&
        isStableSemVer(currentVersion) &&
        isSemVerGreaterThan(resolved.latest, currentVersion)
      ) {
        if (!(await probeVersion(resolved.latest, environment, command))) {
          diagnostic(
            `create-maa-project: version ${resolved.latest} is available but could not be prepared; continuing with ${currentVersion}.\n`,
          )
          await releaseLock()
          return runLocal(args)
        }
        await releaseLock()
        const exitCode = await handOffToVersion(resolved.latest, args, environment, command)
        if (exitCode !== undefined) return exitCode
        diagnostic(`create-maa-project: version ${resolved.latest} was prepared but could not be started.\n`)
        return 1
      }
    }

    await synchronizeSkill(state, directory, currentVersion, now, environment, skillCommand, diagnostic)
    await releaseLock()
    return runLocal(args)
  } finally {
    await releaseLock()
  }
}
