import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ChangedFileReport,
  MaaProjectConfig,
  MaaProjectLock,
  ManagedFileInput,
  ManagedFileState,
  PendingItem
} from './types.js'
import { exists, nowIso, readText, sha256, stableJson, writeText } from './utils.js'

export const CONFIG_FILE = 'maa-project.json'
export const LOCK_FILE = 'maa-project.lock.json'
export const LOCAL_STATE_DIR = '.create-maa-project'

export async function readProjectConfig(root: string): Promise<MaaProjectConfig> {
  const configPath = join(root, CONFIG_FILE)
  if (!(await exists(configPath))) {
    throw new Error(`No ${CONFIG_FILE} found. Run this command in a MaaFW project root.`)
  }
  return JSON.parse(await readText(configPath)) as MaaProjectConfig
}

export async function readProjectLock(root: string): Promise<MaaProjectLock> {
  const lockPath = join(root, LOCK_FILE)
  if (!(await exists(lockPath))) {
    return emptyLock('unknown')
  }
  return JSON.parse(await readText(lockPath)) as MaaProjectLock
}

export function emptyLock(version: string): MaaProjectLock {
  return {
    schemaVersion: 1,
    template: {
      createdBy: 'create-maa-project',
      lastUpdatedBy: 'create-maa-project',
      templateVersion: version
    },
    pending: [],
    managedFiles: {},
    createdFiles: {}
  }
}

export async function writeProjectState(
  root: string,
  config: MaaProjectConfig,
  lock: MaaProjectLock
): Promise<void> {
  const configContent = stableJson(config)
  delete lock.managedFiles[CONFIG_FILE]
  delete lock.managedFiles[LOCK_FILE]
  const configPath = join(root, CONFIG_FILE)
  if ((await exists(configPath)) && (await readText(configPath)) !== configContent) {
    await backupFile(root, CONFIG_FILE)
  }
  await writeText(join(root, CONFIG_FILE), configContent)
  if (await exists(join(root, LOCK_FILE))) {
    await backupFile(root, LOCK_FILE)
  }
  await writeText(join(root, LOCK_FILE), stableJson(lock))
}

export async function acceptManagedChanges(root: string, paths: string[]): Promise<string[]> {
  const lock = await readProjectLock(root)
  const targetPaths = paths.length > 0 ? paths : await changedManagedPaths(root, lock)
  const accepted: string[] = []
  for (const path of targetPaths) {
    const state = lock.managedFiles[path]
    if (!state) {
      throw new Error(`Not a managed file: ${path}`)
    }
    const fullPath = join(root, path)
    if (!(await exists(fullPath))) {
      throw new Error(`Managed file does not exist: ${path}`)
    }
    const content = await readManagedFile(fullPath, path)
    state.hash = managedFileHash(path, content)
    state.acceptedAt = nowIso()
    state.acceptedBy = 'create-maa-project@0.1.0'
    await writeBaseline(root, path, content)
    accepted.push(path)
  }
  if (await exists(join(root, LOCK_FILE))) {
    await backupFile(root, LOCK_FILE)
  }
  await writeText(join(root, LOCK_FILE), stableJson(lock))
  return accepted
}

async function changedManagedPaths(root: string, lock: MaaProjectLock): Promise<string[]> {
  const changed: string[] = []
  for (const [
    path,
    state
  ] of Object.entries(lock.managedFiles).sort(
    ([
        left
      ], [
        right
      ]) => left.localeCompare(right)
  )) {
    const fullPath = join(root, path)
    if (!(await exists(fullPath))) continue
    const currentHash = managedFileHash(path, await readManagedFile(fullPath, path))
    if (currentHash !== state.hash) changed.push(path)
  }
  return changed
}

export async function diffManagedFiles(root: string): Promise<string[]> {
  const lock = await readProjectLock(root)
  const lines: string[] = []

  for (const [
    path,
    state
  ] of Object.entries(lock.managedFiles).sort(
    ([
        left
      ], [
        right
      ]) => left.localeCompare(right)
  )) {
    const currentPath = join(root, path)
    if (!(await exists(currentPath))) {
      lines.push(`[ERR] Managed file is missing: ${path}`)
      lines.push(`      To fix: restore it from backup or run create-maa-project --update template`)
      continue
    }

    const currentContent = await readManagedFile(currentPath, path)
    const currentHash = managedFileHash(path, currentContent)
    if (currentHash === state.hash) continue

    const baselinePath = join(root, LOCAL_STATE_DIR, 'baselines', path)
    if (!(await exists(baselinePath))) {
      lines.push(`[WARN] Baseline is missing for changed managed file: ${path}`)
      lines.push(`       To accept: create-maa-project --accept-changes ${path}`)
      continue
    }

    if (isBinaryPath(path)) {
      lines.push(`[WARN] Binary managed file changed: ${path}`)
      lines.push(`       To accept: create-maa-project --accept-changes ${path}`)
      continue
    }
    const baselineContent = await readText(baselinePath)
    lines.push(...createUnifiedDiff(path, baselineContent, currentContent.toString()))
  }

  return lines.length > 0 ? lines : [
        'No managed file changes.'
      ]
}

export async function listChangedManagedFiles(root: string): Promise<ChangedFileReport[]> {
  const lock = await readProjectLock(root)
  const changed: ChangedFileReport[] = []
  for (const [
    path,
    state
  ] of Object.entries(lock.managedFiles).sort(
    ([
        left
      ], [
        right
      ]) => left.localeCompare(right)
  )) {
    const currentPath = join(root, path)
    if (!(await exists(currentPath))) {
      changed.push({ path, status: 'deleted' })
      continue
    }
    const currentContent = await readManagedFile(currentPath, path)
    const currentHash = managedFileHash(path, currentContent)
    if (currentHash !== state.hash) {
      changed.push({ path, status: 'modified' })
    }
  }
  return changed
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
  options: { clearStale?: boolean } = {}
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
          startedAt: nowIso()
        }),
        {
          encoding: 'utf8',
          flag: 'wx'
        }
      )
      break
    } catch {
      const existing = await readExistingRunLock(lockPath)
      if (existing?.pid && isProcessAlive(existing.pid)) {
        throw new Error(
          `Another create-maa-project command is running for this project (pid ${existing.pid}).`
        )
      }
      if (options.clearStale) {
        await rm(lockPath, { force: true })
        continue
      }
      throw new Error(
        `Stale write lock exists at ${lockPath}. Re-run with --clear-stale-lock after confirming no command is running.`
      )
    }
  }

  try {
    return await action()
  } finally {
    await rm(lockPath, { force: true })
  }
}

export async function refreshManagedFileState(
  root: string,
  lock: MaaProjectLock,
  paths: string[]
): Promise<string[]> {
  const refreshed: string[] = []
  for (const path of paths) {
    const state = lock.managedFiles[path]
    if (!state) continue
    const fullPath = join(root, path)
    if (!(await exists(fullPath))) continue
    const content = await readManagedFile(fullPath, path)
    const hash = managedFileHash(path, content)
    lock.managedFiles[path] = {
      hash,
      templateHash: state.templateHash ?? hash
    }
    await writeBaseline(root, path, content)
    refreshed.push(path)
  }
  return refreshed
}

export async function refreshManagedFileContent(
  root: string,
  lock: MaaProjectLock,
  files: Array<{ path: string; content: string | Buffer }>
): Promise<string[]> {
  const refreshed: string[] = []
  for (const file of files) {
    const state = lock.managedFiles[file.path]
    if (!state) continue
    const hash = managedFileHash(file.path, file.content)
    lock.managedFiles[file.path] = {
      hash,
      templateHash: state.templateHash ?? hash
    }
    await writeBaseline(root, file.path, file.content)
    refreshed.push(file.path)
  }
  return refreshed
}

export async function writeGeneratedFiles(
  root: string,
  files: ManagedFileInput[],
  options: { force: boolean; backup: boolean; overwriteUnmanaged?: boolean }
): Promise<{
  written: string[]
  skipped: string[]
  lockEntries: Record<string, ManagedFileState>
}> {
  const written: string[] = []
  const skipped: string[] = []
  const lockEntries: Record<string, ManagedFileState> = {}

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
    if (file.managed) {
      const hash = managedFileHash(file.path, content)
      lockEntries[file.path] = {
        hash,
        templateHash: hash
      }
      await writeBaseline(root, file.path, content)
    }
  }

  return { written, skipped, lockEntries }
}

export async function backupProjectSnapshot(root: string): Promise<string | undefined> {
  if (!(await exists(root))) return undefined
  const entries = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.name !== '.git' && entry.name !== LOCAL_STATE_DIR
  )
  if (entries.length === 0) return undefined

  const stamp = nowIso().replace(/[:.]/g, '-')
  const backupRoot = join(root, LOCAL_STATE_DIR, 'backups', stamp)
  await mkdir(backupRoot, { recursive: true })
  for (const entry of entries) {
    await cp(join(root, entry.name), join(backupRoot, entry.name), {
      recursive: true,
      force: true
    })
  }
  return stamp
}

export function managedFileHash(path: string, content: string | Buffer): string {
  if (isBinaryPath(path)) return sha256(content)
  const text = content.toString()
  const hashContent = path === '.gitignore' ? (extractGitignoreBlock(text) ?? text) : text
  return sha256(normalizeManagedText(hashContent))
}

export function prepareManagedFileContent(
  _path: string,
  _current: string,
  generated: string
): string {
  return generated
}

function normalizeManagedText(content: string): string {
  return content.replace(/\r\n?/g, '\n')
}

function extractGitignoreBlock(content: string): string | undefined {
  const start = content.indexOf('# BEGIN create-maa-project')
  if (start < 0) return undefined
  const markerEnd = content.indexOf('# END create-maa-project', start)
  if (markerEnd < 0) return undefined
  const end = content.indexOf('\n', markerEnd)
  return content.slice(start, end < 0 ? content.length : end + 1)
}

export async function listDirectoryEntries(path: string): Promise<string[]> {
  if (!(await exists(path))) return []
  return readdir(path)
}

export function mergePending(existing: PendingItem[], next: PendingItem[]): PendingItem[] {
  const map = new Map<string, PendingItem>()
  for (const item of existing) map.set(`${item.kind}:${item.command}`, item)
  for (const item of next) map.set(`${item.kind}:${item.command}`, item)
  return [
    ...map.values()
  ]
}

async function backupFile(root: string, filePath: string): Promise<void> {
  const source = join(root, filePath)
  const stamp = nowIso().replace(/[:.]/g, '-')
  const destination = join(root, LOCAL_STATE_DIR, 'backups', stamp, filePath)
  await mkdir(dirname(destination), { recursive: true })
  await rename(source, destination)
}

async function writeBaseline(
  root: string,
  filePath: string,
  content: string | Buffer
): Promise<void> {
  const target = join(root, LOCAL_STATE_DIR, 'baselines', filePath)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function writeGeneratedFile(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  if (typeof content === 'string') {
    await writeText(path, content)
    return
  }
  await writeFile(path, content)
}

async function readManagedFile(path: string, managedPath: string): Promise<string | Buffer> {
  return isBinaryPath(managedPath) ? readFile(path) : readText(path)
}

function isBinaryPath(path: string): boolean {
  return path.endsWith('.onnx')
}

export function createUnifiedDiff(path: string, before: string, after: string): string[] {
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  const operations = diffLines(beforeLines, afterLines)
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@',
    ...operations
  ]
}

function splitLines(text: string): string[] {
  if (!text) return []
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  return normalized ? normalized.split('\n') : []
}

function diffLines(before: string[], after: string[]): string[] {
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    Array.from({ length: after.length + 1 }, () => 0)
  )
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      table[left]![right] =
        before[left] === after[right]
          ? table[left + 1]![right + 1]! + 1
          : Math.max(table[left + 1]![right]!, table[left]![right + 1]!)
    }
  }

  const lines: string[] = []
  let left = 0
  let right = 0
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      lines.push(` ${before[left]}`)
      left += 1
      right += 1
    } else if (table[left + 1]![right]! >= table[left]![right + 1]!) {
      lines.push(`-${before[left]}`)
      left += 1
    } else {
      lines.push(`+${after[right]}`)
      right += 1
    }
  }
  while (left < before.length) {
    lines.push(`-${before[left]}`)
    left += 1
  }
  while (right < after.length) {
    lines.push(`+${after[right]}`)
    right += 1
  }
  return lines
}

async function restoreDirectory(
  projectRoot: string,
  backupRoot: string,
  current: string,
  restored: string[]
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
