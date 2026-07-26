import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { appendFile, cp, link, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { MaaProjectConfig, ManagedFileInput, PendingItem, ReleaseChannel } from './types.js'
import { exists, nowIso, readText, stableJson, writeFileAtomic, writeText } from './utils.js'

export const CONFIG_FILE = 'maa-project.json'
export const LOCAL_STATE_DIR = '.create-maa-project'
const BACKUP_MANIFEST_FILE = '.create-maa-project-backup.json'
const BACKUP_FILES_DIR = 'files'
const BACKUP_FORMAT = 'create-maa-project-backup'
const WRITE_LOCKS_DIR = 'run-locks'
const WRITE_LOCK_QUEUE_FILE = 'queue.log'
const LEGACY_WRITE_LOCK_FILE = 'run.lock'

type BackupEntry = {
  path: string
  state: 'created' | 'modified'
}

type BackupManifest = {
  format: typeof BACKUP_FORMAT
  schemaVersion: 1
  id: string
  createdAt: string
  command: string
  status: 'in-progress' | 'complete' | 'rolled-back' | 'rollback-failed'
  entries: BackupEntry[]
}

type BackupOperation = {
  root: string
  rootKey: string
  caseSensitivePaths: boolean
  backupRoot: string
  manifest: BackupManifest
  queue: Promise<void>
  active: boolean
}

type WriteLockOwner = {
  rootKey: string
  caseSensitivePaths: boolean
  ownerId: string
  ownerPath: string
  legacyOwnerPath?: string
  active: boolean
}

type WriteLockRecord = {
  ownerId: string
  pid: number
  command: string
  startedAt: string
  state: 'claiming' | 'held'
}

type WriteLockEntry = {
  path: string
  record?: WriteLockRecord
}

const backupOperationStorage = new AsyncLocalStorage<BackupOperation>()
const writeLockStorage = new AsyncLocalStorage<WriteLockOwner>()

export type ProjectWriteOperation = {
  backupId: string
}

export type RestoreResult = {
  restored: string[]
  backupId: string
}

export type BackupInspectionEntry = {
  path: string
  action: 'restore' | 'remove'
}

export type BackupInspection = {
  id: string
  format: 'managed-files' | 'legacy'
  createdAt: string
  command: string | null
  status: BackupManifest['status'] | 'legacy'
  entries: BackupInspectionEntry[]
}

export type BackupSummary = {
  id: string
  format: BackupInspection['format'] | 'invalid'
  createdAt: string
  command: string | null
  status: BackupInspection['status'] | 'invalid'
  entryCount: number
  error?: string
}

export async function listProjectBackups(root: string): Promise<BackupSummary[]> {
  const relativeBackupsRoot = join(LOCAL_STATE_DIR, 'backups')
  await assertNoSymlinkSegments(root, relativeBackupsRoot)
  const backupsRoot = join(root, relativeBackupsRoot)
  if (!(await exists(backupsRoot))) return []

  const entries = await readdir(backupsRoot, { withFileTypes: true })
  const backups = await Promise.all(
    entries.map(async (entry): Promise<BackupSummary> => {
      try {
        const inspection = await inspectProjectBackup(root, entry.name)
        const { entries: inspectedEntries, ...summary } = inspection
        return { ...summary, entryCount: inspectedEntries.length }
      } catch (error) {
        let createdAt = ''
        try {
          createdAt = (await lstat(join(backupsRoot, entry.name))).mtime.toISOString()
        } catch {
          // Keep the invalid entry visible even if its metadata cannot be read.
        }
        return {
          id: entry.name,
          format: 'invalid',
          createdAt,
          command: null,
          status: 'invalid',
          entryCount: 0,
          error: errorMessage(error),
        }
      }
    }),
  )
  return backups.sort((left, right) => {
    const byDate = right.createdAt.localeCompare(left.createdAt)
    return byDate || right.id.localeCompare(left.id)
  })
}

export async function inspectProjectBackup(root: string, backupId: string): Promise<BackupInspection> {
  const { backupRoot, info } = await existingBackupRoot(root, backupId)
  const manifestPath = join(backupRoot, BACKUP_MANIFEST_FILE)
  if (await exists(manifestPath)) {
    const manifest = await readBackupManifest(root, manifestPath, backupId)
    await validateBackupPayload(root, backupRoot, manifest)
    const entries = manifest.entries.map((entry): BackupInspectionEntry => ({
      path: entry.path,
      action: entry.state === 'created' ? 'remove' : 'restore',
    }))
    await validateBackupRestoreTargets(root, entries)
    return {
      id: manifest.id,
      format: 'managed-files',
      createdAt: manifest.createdAt,
      command: manifest.command,
      status: manifest.status,
      entries,
    }
  }

  const paths: string[] = []
  await collectBackupFiles(backupRoot, backupRoot, paths)
  const entries = paths
    .map((path): BackupInspectionEntry => ({ path: normalizeBackupPath(root, path), action: 'restore' }))
    .sort(compareInspectionEntries)
  await validateBackupRestoreTargets(root, entries)
  return {
    id: backupId,
    format: 'legacy',
    createdAt: info.mtime.toISOString(),
    command: null,
    status: 'legacy',
    entries,
  }
}

export async function trackProjectPathForBackup(root: string, filePath: string): Promise<void> {
  await backupPath(root, filePath)
}

export async function restoreTrackedProjectPaths(root: string, filePaths: string[]): Promise<void> {
  const operation = requireBackupOperation(root)
  await serializeBackupMutation(operation, async () => {
    for (const filePath of filePaths) {
      const normalizedPath = normalizeBackupPath(root, filePath)
      const entry = operation.manifest.entries.find(
        (candidate) => backupPathKey(candidate.path) === backupPathKey(normalizedPath),
      )
      if (!entry) {
        throw new Error(`Cannot restore an untracked project path: ${filePath}`)
      }
      await applyBackupEntry(root, operation.backupRoot, entry)
    }
  })
}

export async function readProjectConfig(root: string): Promise<MaaProjectConfig> {
  await assertNoSymlinkSegments(root, CONFIG_FILE)
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
  if (!currentBackupOperation(root)) {
    await withProjectWriteLock(root, 'write project state', () => writeProjectState(root, config))
    return
  }
  await assertNoSymlinkSegments(root, CONFIG_FILE)
  const configContent = stableJson(config)
  const configPath = join(root, CONFIG_FILE)
  if ((await exists(configPath)) && (await readText(configPath)) === configContent) return
  await backupPath(root, CONFIG_FILE)
  await writeGeneratedFile(configPath, configContent)
}

export async function cleanCache(root: string): Promise<string> {
  const cachePath = join(root, LOCAL_STATE_DIR, 'cache')
  await assertNoSymlinkSegments(root, `${LOCAL_STATE_DIR}/cache`)
  await rm(cachePath, { force: true, recursive: true })
  return cachePath
}

export async function restoreBackup(root: string, backupId: string): Promise<RestoreResult> {
  assertValidBackupId(backupId)
  if (!currentWriteLockOwner(root)) {
    return withProjectLock(root, `restore backup ${backupId}`, () => restoreBackup(root, backupId))
  }
  if (!currentBackupOperation(root)) {
    await inspectProjectBackup(root, backupId)
    return withProjectOperation(root, `restore backup ${backupId}`, () => restoreBackup(root, backupId))
  }
  const operation = requireBackupOperation(root)
  if (operation.manifest.id === backupId) throw new Error('Cannot restore the backup for the active operation.')
  const { backupRoot } = await existingBackupRoot(root, backupId)
  const manifestPath = join(backupRoot, BACKUP_MANIFEST_FILE)
  if (await exists(manifestPath)) {
    const manifest = await readBackupManifest(root, manifestPath, backupId)
    await validateBackupPayload(root, backupRoot, manifest)
    return {
      restored: await restoreManifestBackup(root, backupRoot, manifest),
      backupId: operation.manifest.id,
    }
  }
  return {
    restored: await restoreLegacyBackup(root, backupRoot),
    backupId: operation.manifest.id,
  }
}

export async function withProjectOperation<T>(
  root: string,
  command: string,
  action: (operation: ProjectWriteOperation) => Promise<T>,
): Promise<T> {
  if (!currentWriteLockOwner(root)) {
    return withProjectWriteLock(root, command, action)
  }
  const existing = currentBackupOperation(root)
  if (existing) return action({ backupId: existing.manifest.id })

  const operation = await createBackupOperation(root, command)
  try {
    return await backupOperationStorage.run(operation, async () => {
      try {
        const result = await action({ backupId: operation.manifest.id })
        await operation.queue
        await setBackupStatus(operation, 'complete')
        return result
      } catch (error) {
        await operation.queue
        try {
          await validateBackupPayload(root, operation.backupRoot, operation.manifest)
          await applyManifestBackup(root, operation.backupRoot, operation.manifest)
          await setBackupStatus(operation, 'rolled-back')
        } catch (rollbackError) {
          await setBackupStatus(operation, 'rollback-failed').catch(() => undefined)
          throw new AggregateError(
            [error, rollbackError],
            `Project operation failed and backup ${operation.manifest.id} could not be rolled back.`,
          )
        }
        throw error
      }
    })
  } finally {
    operation.active = false
  }
}

export async function withProjectWriteLock<T>(
  root: string,
  command: string,
  action: (operation: ProjectWriteOperation) => Promise<T>,
  options: { clearStale?: boolean } = {},
): Promise<T> {
  return withProjectLock(root, command, () => withProjectOperation(root, command, action), options)
}

export async function withProjectLock<T>(
  root: string,
  command: string,
  action: () => Promise<T>,
  options: { clearStale?: boolean } = {},
): Promise<T> {
  const existingOwner = currentWriteLockOwner(root)
  if (existingOwner) return action()
  const owner = await acquireProjectWriteLock(root, command, options.clearStale === true)

  try {
    return await writeLockStorage.run(owner, action)
  } finally {
    owner.active = false
    await removeOwnedWriteLock(owner)
  }
}

export type WriteGeneratedFilesResult = {
  written: string[]
  skipped: string[]
  backupId?: string
}

export async function writeGeneratedFiles(
  root: string,
  files: ManagedFileInput[],
  options: { force: boolean; backup: boolean; overwriteUnmanaged?: boolean },
): Promise<WriteGeneratedFilesResult> {
  if (options.backup && !currentBackupOperation(root)) {
    return withProjectWriteLock(root, 'write generated files', () => writeGeneratedFiles(root, files, options))
  }
  const written: string[] = []
  const skipped: string[] = []

  for (const file of files) {
    const normalizedPath = normalizeBackupPath(root, file.path)
    await assertNoSymlinkSegments(root, normalizedPath)
    const target = join(root, normalizedPath)
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
    if (options.backup) await backupPath(root, file.path)
    await writeGeneratedFile(target, content)
    written.push(file.path)
  }

  const backupId = currentBackupOperation(root)?.manifest.id
  return backupId ? { written, skipped, backupId } : { written, skipped }
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

async function writeGeneratedFile(path: string, content: string | Buffer): Promise<void> {
  await writeFileAtomic(path, content)
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
    await rm(target, { force: true, recursive: true })
    await cp(source, target, { force: true, verbatimSymlinks: true })
    restored.push(relativePath)
  }
}

async function createBackupOperation(root: string, command: string): Promise<BackupOperation> {
  const id = `${nowIso().replace(/[:.]/g, '-')}-${randomUUID()}`
  const backupRoot = join(root, LOCAL_STATE_DIR, 'backups', id)
  await assertNoSymlinkSegments(root, join(LOCAL_STATE_DIR, 'backups', id))
  await mkdir(backupRoot, { recursive: true })
  const owner = currentWriteLockOwner(root)
  if (!owner) throw new Error('No active project write lock for this backup operation.')
  const operation: BackupOperation = {
    root: resolve(root),
    rootKey: projectRootKey(root),
    caseSensitivePaths: owner.caseSensitivePaths,
    backupRoot,
    manifest: {
      schemaVersion: 1,
      format: BACKUP_FORMAT,
      id,
      createdAt: nowIso(),
      command,
      status: 'in-progress',
      entries: [],
    },
    queue: Promise.resolve(),
    active: true,
  }
  await writeBackupManifest(operation)
  return operation
}

function currentBackupOperation(root: string): BackupOperation | undefined {
  const operation = backupOperationStorage.getStore()
  return operation?.active === true && operation.rootKey === projectRootKey(root) ? operation : undefined
}

function currentWriteLockOwner(root: string): WriteLockOwner | undefined {
  const owner = writeLockStorage.getStore()
  return owner?.active === true && owner.rootKey === projectRootKey(root) ? owner : undefined
}

function requireBackupOperation(root: string): BackupOperation {
  const operation = currentBackupOperation(root)
  if (!operation) throw new Error('No active backup operation for this project.')
  return operation
}

async function backupPath(root: string, filePath: string): Promise<void> {
  const operation = requireBackupOperation(root)
  const requestedPath = normalizeBackupPath(root, filePath)
  await serializeBackupMutation(operation, async () => {
    const normalizedPath = normalizeBackupPath(root, await backupBoundaryPath(root, requestedPath))
    if (operation.manifest.entries.some((entry) => coversBackupPath(entry.path, normalizedPath))) return

    const source = join(root, normalizedPath)
    const sourceExists = await exists(source)
    const coveredEntries = operation.manifest.entries.filter((entry) => coversBackupPath(normalizedPath, entry.path))
    const destination = join(operation.backupRoot, BACKUP_FILES_DIR, normalizedPath)
    if (coveredEntries.length > 0) {
      if (!sourceExists) {
        throw new Error(`Cannot merge child backups into a missing parent path: ${normalizedPath}`)
      }
      await mergeChildBackupPayloads(root, normalizedPath, destination, coveredEntries)
      const coveredKeys = new Set(coveredEntries.map((entry) => backupPathKey(entry.path)))
      operation.manifest.entries = operation.manifest.entries.filter(
        (entry) => !coveredKeys.has(backupPathKey(entry.path)),
      )
    } else if (sourceExists) {
      await mkdir(dirname(destination), { recursive: true })
      await cp(source, destination, { recursive: true, force: true, verbatimSymlinks: true })
    }
    operation.manifest.entries.push({
      path: normalizedPath,
      state: sourceExists ? 'modified' : 'created',
    })
    operation.manifest.entries.sort(compareBackupEntries)
    await writeBackupManifest(operation)
  })
}

async function mergeChildBackupPayloads(
  root: string,
  parentPath: string,
  destination: string,
  childEntries: BackupEntry[],
): Promise<void> {
  const source = join(root, parentPath)
  const parentSegments = parentPath.split('/').length
  const childPaths = childEntries.map((entry) => {
    const childPath = entry.path.split('/').slice(parentSegments).join('/')
    if (!childPath) throw new Error(`Cannot merge an invalid child backup path: ${entry.path}`)
    return childPath
  })
  await mkdir(destination, { recursive: true })
  await cp(source, destination, {
    recursive: true,
    force: false,
    verbatimSymlinks: true,
    filter: (sourcePath) => {
      const childCandidate = relative(source, sourcePath).replaceAll('\\', '/')
      return !childCandidate || !childPaths.some((childPath) => coversBackupPath(childPath, childCandidate))
    },
  })
}

async function backupBoundaryPath(root: string, relativePath: string): Promise<string> {
  let current = resolve(root)
  const canonicalRoot = await realpath(current)
  for (const segment of relativePath.split('/')) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        throw new Error(`Refusing to back up or restore through a symbolic link: ${relativePath}`)
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        const canonicalParent = await realpath(dirname(current))
        return relative(canonicalRoot, join(canonicalParent, segment)).replaceAll('\\', '/')
      }
      throw error
    }
  }
  return relative(canonicalRoot, await realpath(current)).replaceAll('\\', '/')
}

function coversBackupPath(parent: string, candidate: string): boolean {
  const parentKey = backupPathKey(parent)
  const candidateKey = backupPathKey(candidate)
  return parentKey === candidateKey || candidateKey.startsWith(`${parentKey}/`)
}

function backupPathKey(path: string): string {
  const operation = backupOperationStorage.getStore()
  const owner = writeLockStorage.getStore()
  const caseSensitivePaths = operation?.caseSensitivePaths ?? owner?.caseSensitivePaths ?? process.platform !== 'win32'
  return caseSensitivePaths ? path : path.toLowerCase()
}

function compareBackupEntries(left: BackupEntry, right: BackupEntry): number {
  const leftKey = backupPathKey(left.path)
  const rightKey = backupPathKey(right.path)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left.path < right.path ? -1 : left.path > right.path ? 1 : 0
}

async function writeBackupManifest(operation: BackupOperation): Promise<void> {
  const manifestPath = join(operation.backupRoot, BACKUP_MANIFEST_FILE)
  const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`
  try {
    await writeText(temporaryPath, stableJson(operation.manifest))
    await rename(temporaryPath, manifestPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function readBackupManifest(root: string, path: string, backupId: string): Promise<BackupManifest> {
  let value: unknown
  try {
    value = JSON.parse(await readText(path))
  } catch (error) {
    throw new Error(`Backup manifest is malformed: ${backupId}`, { cause: error })
  }
  if (
    !isRecord(value) ||
    value.format !== BACKUP_FORMAT ||
    value.schemaVersion !== 1 ||
    value.id !== backupId ||
    !Array.isArray(value.entries)
  ) {
    throw new Error(`Backup manifest is invalid: ${backupId}`)
  }
  const entries = value.entries.map((entry): BackupEntry => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== 'string' ||
      (entry.state !== 'created' && entry.state !== 'modified')
    ) {
      throw new Error(`Backup manifest is invalid: ${backupId}`)
    }
    return {
      path: normalizeBackupPath(root, entry.path),
      state: entry.state,
    }
  })
  return {
    format: BACKUP_FORMAT,
    schemaVersion: 1,
    id: backupId,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    command: typeof value.command === 'string' ? value.command : '',
    status: isBackupStatus(value.status) ? value.status : 'in-progress',
    entries,
  }
}

async function validateBackupPayload(root: string, backupRoot: string, manifest: BackupManifest): Promise<void> {
  const seen = new Set<string>()
  for (const entry of manifest.entries) {
    const canonicalPath = await canonicalBackupTargetPath(root, entry.path)
    const entryKey = backupPathKey(canonicalPath)
    if ([...seen].some((path) => coversBackupPath(path, entryKey) || coversBackupPath(entryKey, path))) {
      throw new Error(`Backup manifest contains an overlapping path: ${entry.path}`)
    }
    seen.add(entryKey)
    if (entry.state === 'modified' && !(await exists(join(backupRoot, BACKUP_FILES_DIR, entry.path)))) {
      throw new Error(`Backup payload is missing: ${entry.path}`)
    }
    if (entry.state === 'modified') {
      await assertNoSymlinkSegments(join(backupRoot, BACKUP_FILES_DIR), entry.path)
    }
  }
}

async function canonicalBackupTargetPath(root: string, filePath: string): Promise<string> {
  const normalizedPath = normalizeBackupPath(root, filePath)
  const segments = normalizedPath.split('/')
  const canonicalRoot = await realpath(resolve(root))
  let current = resolve(root)
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        if (index < segments.length - 1) {
          throw new Error(`Refusing to back up or restore through a symbolic link: ${filePath}`)
        }
        const canonicalParent = await realpath(dirname(current))
        return normalizeBackupPath(root, relative(canonicalRoot, join(canonicalParent, segment)))
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        const canonicalParent = await realpath(dirname(current))
        return normalizeBackupPath(root, relative(canonicalRoot, join(canonicalParent, ...segments.slice(index))))
      }
      throw error
    }
  }
  return normalizeBackupPath(root, relative(canonicalRoot, await realpath(current)))
}

async function restoreManifestBackup(root: string, backupRoot: string, manifest: BackupManifest): Promise<string[]> {
  for (const entry of manifest.entries) await backupPath(root, entry.path)
  await applyManifestBackup(root, backupRoot, manifest)
  return manifest.entries.map((entry) => entry.path)
}

async function applyManifestBackup(root: string, backupRoot: string, manifest: BackupManifest): Promise<void> {
  for (const entry of manifest.entries) await applyBackupEntry(root, backupRoot, entry)
}

async function applyBackupEntry(root: string, backupRoot: string, entry: BackupEntry): Promise<void> {
  await assertNoSymlinkParents(root, entry.path)
  const target = join(root, entry.path)
  await rm(target, { force: true, recursive: true })
  if (entry.state === 'created') return
  const source = join(backupRoot, BACKUP_FILES_DIR, entry.path)
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true, force: true, verbatimSymlinks: true })
}

async function restoreLegacyBackup(root: string, backupRoot: string): Promise<string[]> {
  const paths: string[] = []
  await collectBackupFiles(backupRoot, backupRoot, paths)
  for (const path of paths) await backupPath(root, path)
  const restored: string[] = []
  await restoreDirectory(root, backupRoot, backupRoot, restored)
  return restored
}

async function collectBackupFiles(backupRoot: string, current: string, paths: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const source = join(current, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Legacy backup contains a symbolic link: ${entry.name}`)
    if (entry.isDirectory()) {
      await collectBackupFiles(backupRoot, source, paths)
    } else {
      paths.push(source.slice(backupRoot.length + 1).replaceAll('\\', '/'))
    }
  }
}

async function existingBackupRoot(
  root: string,
  backupId: string,
): Promise<{ backupRoot: string; info: Awaited<ReturnType<typeof lstat>> }> {
  assertValidBackupId(backupId)
  const relativeBackupRoot = join(LOCAL_STATE_DIR, 'backups', backupId)
  await assertNoSymlinkSegments(root, relativeBackupRoot)
  const backupRoot = join(root, relativeBackupRoot)
  if (!(await exists(backupRoot))) throw new Error(`Backup does not exist: ${backupId}`)
  const info = await lstat(backupRoot)
  if (!info.isDirectory()) throw new Error(`Backup is not a directory: ${backupId}`)
  return { backupRoot, info }
}

function compareInspectionEntries(left: BackupInspectionEntry, right: BackupInspectionEntry): number {
  return left.path.localeCompare(right.path)
}

async function validateBackupRestoreTargets(root: string, entries: BackupInspectionEntry[]): Promise<void> {
  for (const entry of entries) {
    normalizeBackupPath(root, await backupBoundaryPath(root, entry.path))
  }
}

async function assertNoSymlinkSegments(root: string, relativePath: string): Promise<void> {
  let current = resolve(root)
  for (const segment of relativePath.replaceAll('\\', '/').split('/')) {
    current = join(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) {
        throw new Error(`Refusing to back up or restore through a symbolic link: ${relativePath}`)
      }
    } catch (error) {
      if (isFileNotFoundError(error)) return
      throw error
    }
  }
}

async function assertNoSymlinkParents(root: string, relativePath: string): Promise<void> {
  const segments = relativePath.replaceAll('\\', '/').split('/')
  if (segments.length <= 1) return
  await assertNoSymlinkSegments(root, segments.slice(0, -1).join('/'))
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeBackupPath(root: string, filePath: string): string {
  const portablePath = filePath.replaceAll('\\', '/')
  const portableSegments = portablePath.split('/')
  if (
    !portablePath ||
    portablePath.includes('\0') ||
    isAbsolute(portablePath) ||
    win32.isAbsolute(filePath) ||
    portableSegments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.trimEnd().replace(/[.]+$/u, '') !== segment ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    )
  ) {
    throw new Error(`Invalid backup path: ${filePath}`)
  }
  const projectRoot = resolve(root)
  const absolutePath = resolve(projectRoot, portablePath)
  const relativePath = relative(projectRoot, absolutePath)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Invalid backup path: ${filePath}`)
  }
  const normalizedPath = relativePath.replaceAll('\\', '/')
  const segments = normalizedPath.split('/')
  const topLevel = segments[0]?.toLowerCase()
  const stateChild = segments[1]?.toLowerCase()
  if (topLevel === '.git' || (topLevel === LOCAL_STATE_DIR.toLowerCase() && stateChild !== 'runtime')) {
    throw new Error(`Protected project state cannot be backed up or restored: ${filePath}`)
  }
  return normalizedPath
}

function assertValidBackupId(backupId: string): void {
  if (
    !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(backupId) ||
    backupId.includes('..') ||
    backupId.endsWith('.') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(backupId)
  ) {
    throw new Error(`Invalid backup id: ${backupId}`)
  }
}

async function serializeBackupMutation(operation: BackupOperation, action: () => Promise<void>): Promise<void> {
  const result = operation.queue.then(action, action)
  operation.queue = result.then(
    () => undefined,
    () => undefined,
  )
  await result
}

async function setBackupStatus(operation: BackupOperation, status: BackupManifest['status']): Promise<void> {
  await operation.queue
  operation.manifest.status = status
  await writeBackupManifest(operation)
}

function isBackupStatus(value: unknown): value is BackupManifest['status'] {
  return value === 'in-progress' || value === 'complete' || value === 'rolled-back' || value === 'rollback-failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function acquireProjectWriteLock(root: string, command: string, clearStale: boolean): Promise<WriteLockOwner> {
  const statePath = join(resolve(root), LOCAL_STATE_DIR)
  await assertNoSymlinkSegments(root, LOCAL_STATE_DIR)
  await mkdir(statePath, { recursive: true })
  const canonicalRoot = await realpath(resolve(root))
  const rootKey = projectRootKey(canonicalRoot)
  const caseSensitivePaths = await detectPathCaseSensitivity(statePath)
  const legacyLockPath = join(canonicalRoot, LOCAL_STATE_DIR, LEGACY_WRITE_LOCK_FILE)

  const locksPath = join(canonicalRoot, LOCAL_STATE_DIR, WRITE_LOCKS_DIR)
  await assertNoSymlinkSegments(canonicalRoot, join(LOCAL_STATE_DIR, WRITE_LOCKS_DIR))
  await mkdir(locksPath, { recursive: true })
  const ownerId = randomUUID()
  const ownerPath = join(locksPath, `${ownerId}.json`)
  const ownerRecord: WriteLockRecord = {
    ownerId,
    pid: process.pid,
    command,
    startedAt: nowIso(),
    state: 'claiming',
  }
  const owner: WriteLockOwner = { rootKey, caseSensitivePaths, ownerId, ownerPath, active: true }
  try {
    await publishWriteLockRecord(statePath, ownerPath, ownerRecord, false)
    const queuePath = join(locksPath, WRITE_LOCK_QUEUE_FILE)
    await assertNoSymlinkSegments(canonicalRoot, join(LOCAL_STATE_DIR, WRITE_LOCKS_DIR, WRITE_LOCK_QUEUE_FILE))
    await appendFile(queuePath, `${ownerId}\n`, { encoding: 'utf8', flag: 'a' })

    const entries = await readWriteLockEntries(locksPath)
    const abandonedClaims = entries.filter(
      (entry) => entry.record?.state === 'claiming' && !isProcessAlive(entry.record.pid),
    )
    for (const entry of abandonedClaims) await rm(entry.path, { force: true })
    const staleEntries = entries.filter(
      (entry) => !entry.record || (entry.record.state === 'held' && !isProcessAlive(entry.record.pid)),
    )
    if (staleEntries.length > 0 && !clearStale) {
      throw new Error(
        `Stale write lock exists at ${locksPath}. Re-run with --clear-stale-lock after confirming no command is running.`,
      )
    }
    for (const entry of staleEntries) await rm(entry.path, { force: true, recursive: true })

    const activeEntries = entries.filter(
      (entry): entry is WriteLockEntry & { record: WriteLockRecord } =>
        entry.record !== undefined && isProcessAlive(entry.record.pid),
    )
    const heldEntry = activeEntries.find((entry) => entry.record.state === 'held' && entry.record.ownerId !== ownerId)
    if (heldEntry) {
      throw new Error(`Another create-maa-project command is running for this project (pid ${heldEntry.record.pid}).`)
    }

    const queue = await readWriteLockQueue(queuePath)
    const activeOwners = new Map(activeEntries.map((entry) => [entry.record.ownerId, entry.record]))
    const winnerId = queue.find((candidate) => activeOwners.has(candidate))
    if (winnerId !== ownerId) {
      const winner = winnerId ? activeOwners.get(winnerId) : undefined
      if (winner) {
        throw new Error(`Another create-maa-project command is running for this project (pid ${winner.pid}).`)
      }
      throw new Error(`Could not establish ownership of the project write lock at ${locksPath}. Re-run the command.`)
    }

    ownerRecord.state = 'held'
    await publishWriteLockRecord(statePath, ownerPath, ownerRecord, true)
    const verifiedOwner = await readWriteLockRecord(ownerPath)
    if (verifiedOwner?.ownerId !== ownerId || verifiedOwner.state !== 'held') {
      throw new Error(`Project write lock ownership changed before acquisition completed: ${ownerPath}`)
    }
    await publishLegacyWriteLockBridge(statePath, legacyLockPath, ownerRecord, clearStale)
    owner.legacyOwnerPath = legacyLockPath
    return owner
  } catch (error) {
    owner.active = false
    await removeOwnedWriteLock(owner).catch(() => undefined)
    throw error
  }
}

async function handleLegacyWriteLock(path: string, clearStale: boolean): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isFileNotFoundError(error)) return
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Invalid legacy write lock at ${path}. Remove it after confirming no command is running.`)
  }
  const existing = await readLegacyWriteLockRecord(path)
  if (existing?.pid && isProcessAlive(existing.pid)) {
    throw new Error(`Another create-maa-project command is running for this project (pid ${existing.pid}).`)
  }
  if (!clearStale) {
    throw new Error(
      `Stale write lock exists at ${path}. Re-run with --clear-stale-lock after confirming no command is running.`,
    )
  }
  if (!existing?.ownerId) {
    throw new Error(
      `Legacy stale write lock exists at ${path}. Remove that file manually after confirming no older create-maa-project command is running.`,
    )
  }
  const retiredPath = join(dirname(path), `.retired-${LEGACY_WRITE_LOCK_FILE}-${randomUUID()}`)
  try {
    await rename(path, retiredPath)
  } catch (error) {
    if (isFileNotFoundError(error)) return handleLegacyWriteLock(path, clearStale)
    throw error
  }
  await rm(retiredPath, { force: true })
}

async function publishLegacyWriteLockBridge(
  statePath: string,
  path: string,
  record: WriteLockRecord,
  clearStale: boolean,
): Promise<void> {
  const temporaryPath = join(statePath, `.legacy-write-lock-${record.ownerId}-${randomUUID()}.tmp`)
  try {
    await writeFile(
      temporaryPath,
      stableJson({
        ownerId: record.ownerId,
        pid: record.pid,
        command: record.command,
        startedAt: record.startedAt,
      }),
      { encoding: 'utf8', flag: 'wx' },
    )
    for (;;) {
      try {
        await link(temporaryPath, path)
        return
      } catch (error) {
        if (!isErrorWithCode(error, 'EEXIST')) throw error
        await handleLegacyWriteLock(path, clearStale)
      }
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function readLegacyWriteLockRecord(path: string): Promise<{ ownerId?: string; pid?: number } | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await readText(path))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  if (!isRecord(value)) return undefined
  return {
    ...(typeof value.ownerId === 'string' ? { ownerId: value.ownerId } : {}),
    ...(typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0 ? { pid: value.pid } : {}),
  }
}

async function readWriteLockEntries(locksPath: string): Promise<WriteLockEntry[]> {
  const entries: WriteLockEntry[] = []
  for (const entry of await readdir(locksPath, { withFileTypes: true })) {
    if (entry.name === WRITE_LOCK_QUEUE_FILE) continue
    const path = join(locksPath, entry.name)
    if (!entry.isFile() || entry.isSymbolicLink()) {
      entries.push({ path })
      continue
    }
    let record: WriteLockRecord | undefined
    try {
      record = await readWriteLockRecord(path)
    } catch (error) {
      if (isFileNotFoundError(error)) continue
      throw error
    }
    if (!record || entry.name !== `${record.ownerId}.json`) {
      entries.push({ path })
      continue
    }
    entries.push({ path, record })
  }
  return entries
}

async function readWriteLockRecord(path: string): Promise<WriteLockRecord | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await readText(path))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  if (
    !isRecord(value) ||
    typeof value.ownerId !== 'string' ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.command !== 'string' ||
    typeof value.startedAt !== 'string' ||
    (value.state !== 'claiming' && value.state !== 'held')
  ) {
    return undefined
  }
  return {
    ownerId: value.ownerId,
    pid: value.pid,
    command: value.command,
    startedAt: value.startedAt,
    state: value.state,
  }
}

async function readWriteLockQueue(path: string): Promise<string[]> {
  if (!(await exists(path))) return []
  return (await readText(path))
    .split(/\r?\n/u)
    .filter((ownerId) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(ownerId))
}

async function publishWriteLockRecord(
  statePath: string,
  ownerPath: string,
  record: WriteLockRecord,
  replace: boolean,
): Promise<void> {
  const temporaryPath = join(statePath, `.write-lock-${record.ownerId}-${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, stableJson(record), { encoding: 'utf8', flag: 'wx' })
    if (!replace && (await exists(ownerPath))) {
      throw new Error(`Project write lock owner already exists: ${ownerPath}`)
    }
    await renameWriteLockRecord(temporaryPath, ownerPath)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function renameWriteLockRecord(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      if (
        attempt >= 2 ||
        !(isErrorWithCode(error, 'EACCES') || isErrorWithCode(error, 'EBUSY') || isErrorWithCode(error, 'EPERM'))
      ) {
        throw error
      }
      await delay(10 * (attempt + 1))
    }
  }
}

async function removeOwnedWriteLock(owner: WriteLockOwner): Promise<void> {
  if (owner.legacyOwnerPath) {
    let legacyRecord: { ownerId?: string; pid?: number } | undefined
    try {
      legacyRecord = await readLegacyWriteLockRecord(owner.legacyOwnerPath)
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error
    }
    if (legacyRecord?.ownerId !== owner.ownerId) {
      if (await exists(owner.legacyOwnerPath)) {
        throw new Error(`Legacy project write lock ownership changed unexpectedly: ${owner.legacyOwnerPath}`)
      }
    } else {
      await rm(owner.legacyOwnerPath, { force: true })
    }
  }
  let record: WriteLockRecord | undefined
  try {
    record = await readWriteLockRecord(owner.ownerPath)
  } catch (error) {
    if (isFileNotFoundError(error)) return
    throw error
  }
  if (!record) {
    if (!(await exists(owner.ownerPath))) return
    throw new Error(`Project write lock ownership metadata is invalid: ${owner.ownerPath}`)
  }
  if (record.ownerId !== owner.ownerId) {
    throw new Error(`Project write lock ownership changed unexpectedly: ${owner.ownerPath}`)
  }
  await rm(owner.ownerPath, { force: true })
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function projectRootKey(root: string): string {
  try {
    const canonicalRoot = realpathSync.native(resolve(root))
    const info = statSync(canonicalRoot, { bigint: true })
    return `fs:${info.dev}:${info.ino}`
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error
  }
  const resolvedRoot = resolve(root)
  return `path:${process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot}`
}

async function detectPathCaseSensitivity(root: string): Promise<boolean> {
  const probeName = `.create-maa-project-case-probe-${randomUUID()}-a`
  const probePath = join(root, probeName)
  const alternatePath = join(root, probeName.toUpperCase())
  await writeFile(probePath, '', { encoding: 'utf8', flag: 'wx' })
  try {
    try {
      await lstat(alternatePath)
      return false
    } catch (error) {
      if (isFileNotFoundError(error)) return true
      throw error
    }
  } finally {
    await rm(probePath, { force: true })
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isRecord(error) && error.code === 'EPERM') return true
    return false
  }
}
