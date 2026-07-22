import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MaaProjectConfig, ManagedFileInput, PendingItem, ReleaseChannel } from './types.js'
import { exists, nowIso, readText, stableJson, writeText } from './utils.js'

export const CONFIG_FILE = 'maa-project.json'
export const LOCAL_STATE_DIR = '.create-maa-project'

export async function readProjectConfig(root: string): Promise<MaaProjectConfig> {
  const configPath = join(root, CONFIG_FILE)
  if (!(await exists(configPath))) {
    throw new Error(`No ${CONFIG_FILE} found. Run this command in a MaaFW project root.`)
  }
  const config = JSON.parse(await readText(configPath)) as MaaProjectConfig
  return migrateProjectConfig(config)
}

function migrateProjectConfig(config: MaaProjectConfig): MaaProjectConfig {
  if (config.schemaVersion !== 1 && config.schemaVersion !== 2) {
    throw new Error(`Unsupported maa-project.json schemaVersion: ${String(config.schemaVersion)}`)
  }
  if (config.schemaVersion === 1) {
    migrateReleaseSelector(config.maafw)
    migrateReleaseSelector(config.runtime.mfa)
    if (config.runtime.mxu) migrateReleaseSelector(config.runtime.mxu)
    config.schemaVersion = 2
  }
  normalizeReleaseSelector(config.maafw, 'maafw')
  normalizeReleaseSelector(config.runtime.mfa, 'runtime.mfa')
  if (config.runtime.mxu) normalizeReleaseSelector(config.runtime.mxu, 'runtime.mxu')
  return config
}

function normalizeReleaseSelector(selector: { channel: string; version?: string }, path: string): void {
  selector.channel = selector.channel.trim()
  selector.version = selector.version?.trim() ?? ''
  if (!isReleaseChannel(selector.channel)) {
    throw new Error(`${path}.channel must be one of: stable, beta, alpha`)
  }
}

function migrateReleaseSelector(selector: { channel: string; version?: string }): void {
  const legacy = selector.channel.trim()
  if (legacy === 'latest') {
    selector.channel = 'stable'
    selector.version = ''
    return
  }
  if (isReleaseChannel(legacy)) {
    selector.channel = legacy
    selector.version = ''
    return
  }
  selector.channel = inferReleaseChannel(legacy)
  selector.version = legacy
}

function isReleaseChannel(value: string): value is ReleaseChannel {
  return value === 'stable' || value === 'beta' || value === 'alpha'
}

function inferReleaseChannel(version: string): ReleaseChannel {
  const lower = version.toLowerCase()
  if (/(?:^|[.-])alpha(?:[.-]|$)/.test(lower)) return 'alpha'
  if (/(?:^|[.-])beta(?:[.-]|$)/.test(lower)) return 'beta'
  if (/(?:^|[.-])rc(?:[.-]|$)/.test(lower)) return 'beta'
  return 'stable'
}

export async function writeProjectState(root: string, config: MaaProjectConfig): Promise<void> {
  const configContent = stableJson(config)
  const configPath = join(root, CONFIG_FILE)
  if ((await exists(configPath)) && (await readText(configPath)) !== configContent) {
    await backupFile(root, CONFIG_FILE)
  }
  await writeText(configPath, configContent)
}

export async function cleanCache(root: string): Promise<string> {
  const cachePath = join(root, LOCAL_STATE_DIR, 'cache')
  await rm(cachePath, { force: true, recursive: true })
  return cachePath
}

export async function restoreBackup(root: string, backupId: string): Promise<string[]> {
  if (backupId.includes('/') || backupId.includes('\\') || backupId.includes('..')) {
    throw new Error(`Invalid backup id: ${backupId}`)
  }
  const backupRoot = join(root, LOCAL_STATE_DIR, 'backups', backupId)
  if (!(await exists(backupRoot))) {
    throw new Error(`Backup does not exist: ${backupId}`)
  }
  const restored: string[] = []
  await restoreDirectory(root, backupRoot, backupRoot, restored)
  return restored
}

export async function withProjectWriteLock<T>(
  root: string,
  command: string,
  action: () => Promise<T>,
  options: { clearStale?: boolean } = {},
): Promise<T> {
  const lockPath = join(root, LOCAL_STATE_DIR, 'run.lock')
  await mkdir(dirname(lockPath), { recursive: true })
  for (;;) {
    try {
      await writeFile(
        lockPath,
        stableJson({
          pid: process.pid,
          command,
          startedAt: nowIso(),
        }),
        {
          encoding: 'utf8',
          flag: 'wx',
        },
      )
      break
    } catch {
      const existing = await readExistingRunLock(lockPath)
      if (existing?.pid && isProcessAlive(existing.pid)) {
        throw new Error(`Another create-maa-project command is running for this project (pid ${existing.pid}).`)
      }
      if (options.clearStale) {
        await rm(lockPath, { force: true })
        continue
      }
      throw new Error(
        `Stale write lock exists at ${lockPath}. Re-run with --clear-stale-lock after confirming no command is running.`,
      )
    }
  }

  try {
    return await action()
  } finally {
    await rm(lockPath, { force: true })
  }
}

export async function writeGeneratedFiles(
  root: string,
  files: ManagedFileInput[],
  options: { force: boolean; backup: boolean; overwriteUnmanaged?: boolean },
): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = []
  const skipped: string[] = []

  if (options.backup) {
    await mkdir(join(root, LOCAL_STATE_DIR, 'backups'), { recursive: true })
  }

  for (const file of files) {
    const target = join(root, file.path)
    const existed = await exists(target)
    if (existed && !options.force) {
      skipped.push(file.path)
      continue
    }
    if (existed && !file.managed && !options.overwriteUnmanaged) {
      skipped.push(file.path)
      continue
    }
    const content =
      existed && typeof file.content === 'string'
        ? prepareManagedFileContent(file.path, await readText(target), file.content)
        : file.content
    if (existed && options.backup) {
      await backupFile(root, file.path)
    }
    await writeGeneratedFile(target, content)
    written.push(file.path)
  }

  return { written, skipped }
}

export async function backupProjectSnapshot(root: string): Promise<string | undefined> {
  if (!(await exists(root))) return undefined
  const entries = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.name !== '.git' && entry.name !== LOCAL_STATE_DIR,
  )
  if (entries.length === 0) return undefined

  const stamp = nowIso().replace(/[:.]/g, '-')
  const backupRoot = join(root, LOCAL_STATE_DIR, 'backups', stamp)
  await mkdir(backupRoot, { recursive: true })
  for (const entry of entries) {
    await cp(join(root, entry.name), join(backupRoot, entry.name), {
      recursive: true,
      force: true,
    })
  }
  return stamp
}

export function prepareManagedFileContent(_path: string, _current: string, generated: string): string {
  return generated
}

export async function listDirectoryEntries(path: string): Promise<string[]> {
  if (!(await exists(path))) return []
  return readdir(path)
}

export function mergePending(existing: PendingItem[], next: PendingItem[]): PendingItem[] {
  const map = new Map<string, PendingItem>()
  for (const item of existing) map.set(`${item.kind}:${item.command}`, item)
  for (const item of next) map.set(`${item.kind}:${item.command}`, item)
  return [...map.values()]
}

async function backupFile(root: string, filePath: string): Promise<void> {
  const source = join(root, filePath)
  const stamp = nowIso().replace(/[:.]/g, '-')
  const destination = join(root, LOCAL_STATE_DIR, 'backups', stamp, filePath)
  await mkdir(dirname(destination), { recursive: true })
  await rename(source, destination)
}

async function writeGeneratedFile(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  if (typeof content === 'string') {
    await writeText(path, content)
    return
  }
  await writeFile(path, content)
}

async function restoreDirectory(
  projectRoot: string,
  backupRoot: string,
  current: string,
  restored: string[],
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const source = join(current, entry.name)
    if (entry.isDirectory()) {
      await restoreDirectory(projectRoot, backupRoot, source, restored)
      continue
    }
    const relativePath = source.slice(backupRoot.length + 1).replaceAll('\\', '/')
    const target = join(projectRoot, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target, { force: true })
    restored.push(relativePath)
  }
}

async function readExistingRunLock(path: string): Promise<{ pid?: number } | undefined> {
  try {
    return JSON.parse(await readText(path)) as { pid?: number }
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
