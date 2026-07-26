import { link, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  restoreBackup,
  trackProjectPathForBackup,
  withProjectLock,
  withProjectWriteLock,
  writeGeneratedFiles,
} from '../src/project.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('operation backups', () => {
  it('groups overwritten and created files under one discoverable backup id', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'existing.txt'), 'before', 'utf8')

    const result = await withProjectWriteLock(root, 'test grouped backup', async (operation) => {
      const written = await writeGeneratedFiles(
        root,
        [
          { path: 'existing.txt', content: 'after', managed: true },
          { path: 'created.txt', content: 'created', managed: true },
        ],
        { force: true, backup: true },
      )
      return {
        root,
        written: written.written,
        skipped: written.skipped,
        pending: [],
        backupId: operation.backupId,
      }
    })

    expect(result.backupId).toBeTruthy()
    expect(await backupIds(root)).toEqual([result.backupId])
    const manifest = await readManifest(root, result.backupId as string)
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      id: result.backupId,
      command: 'test grouped backup',
      entries: [
        { path: 'created.txt', state: 'created' },
        { path: 'existing.txt', state: 'modified' },
      ],
    })
    expect(await readFile(backupFile(root, result.backupId as string, 'existing.txt'), 'utf8')).toBe('before')
  })

  it('removes operation-created files and creates a reversible pre-restore backup', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'existing.txt'), 'before', 'utf8')
    const changed = await withProjectWriteLock(root, 'change files', async (operation) => {
      const writeResult = await writeGeneratedFiles(
        root,
        [
          { path: 'existing.txt', content: 'after', managed: true },
          { path: 'created.txt', content: 'created', managed: true },
        ],
        { force: true, backup: true },
      )
      return {
        root,
        written: writeResult.written,
        skipped: writeResult.skipped,
        pending: [],
        backupId: operation.backupId,
      }
    })

    const restoreResult = await withProjectWriteLock(root, 'restore change', () =>
      restoreBackup(root, changed.backupId as string),
    )

    expect(restoreResult.restored).toEqual([
      'created.txt',
      'existing.txt',
    ])
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('before')
    await expect(readFile(join(root, 'created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    expect(restoreResult.backupId).toBeTruthy()
    await withProjectWriteLock(root, 'undo restore', () => restoreBackup(root, restoreResult.backupId))
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('after')
    expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('created')
  })

  it('validates every payload before changing project files', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'existing.txt'), 'before', 'utf8')
    const changed = await withProjectWriteLock(root, 'change one file', async (operation) => {
      const writeResult = await writeGeneratedFiles(root, [{ path: 'existing.txt', content: 'after', managed: true }], {
        force: true,
        backup: true,
      })
      return {
        root,
        written: writeResult.written,
        skipped: writeResult.skipped,
        pending: [],
        backupId: operation.backupId,
      }
    })
    const manifestPath = join(
      root,
      '.create-maa-project',
      'backups',
      changed.backupId as string,
      '.create-maa-project-backup.json',
    )
    const manifest = await readManifest(root, changed.backupId as string)
    manifest.entries.push({ path: 'missing.txt', state: 'modified' })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8')

    await expect(
      withProjectWriteLock(root, 'restore corrupt backup', () => restoreBackup(root, changed.backupId as string)),
    ).rejects.toThrow('Backup payload is missing: missing.txt')
    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('after')
  })

  it('rejects portable traversal paths in backup manifests', async () => {
    const root = await temporaryRoot()
    const backupId = 'malicious-backup'
    const backupRoot = join(root, '.create-maa-project', 'backups', backupId)
    await writeFile(join(root, 'sentinel.txt'), 'untouched', 'utf8')
    await mkdir(backupRoot, { recursive: true })
    await writeFile(
      join(backupRoot, '.create-maa-project-backup.json'),
      `${JSON.stringify({
        format: 'create-maa-project-backup',
        schemaVersion: 1,
        id: backupId,
        createdAt: new Date().toISOString(),
        command: 'malicious',
        status: 'complete',
        entries: [{ path: 'nested\\..\\..\\outside.txt', state: 'created' }],
      })}\n`,
      'utf8',
    )

    await expect(withProjectWriteLock(root, 'restore traversal', () => restoreBackup(root, backupId))).rejects.toThrow(
      'Invalid backup path',
    )
    expect(await readFile(join(root, 'sentinel.txt'), 'utf8')).toBe('untouched')
  })

  it('automatically rolls back all registered paths when an operation fails', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'existing.txt'), 'before', 'utf8')
    let backupId = ''

    await expect(
      withProjectWriteLock(root, 'failing operation', async (operation) => {
        backupId = operation.backupId
        await writeGeneratedFiles(
          root,
          [
            { path: 'existing.txt', content: 'after', managed: true },
            { path: 'created.txt', content: 'created', managed: true },
          ],
          { force: true, backup: true },
        )
        throw new Error('simulated failure')
      }),
    ).rejects.toThrow('simulated failure')

    expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('before')
    await expect(readFile(join(root, 'created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readManifest(root, backupId)).toMatchObject({ status: 'rolled-back' })
  })

  it('serializes concurrent backup registrations without dropping manifest entries', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'first.txt'), 'first-before', 'utf8')
    await writeFile(join(root, 'second.txt'), 'second-before', 'utf8')

    const backupId = await withProjectWriteLock(root, 'parallel writes', async (operation) => {
      await Promise.all([
        writeGeneratedFiles(root, [{ path: 'first.txt', content: 'first-after', managed: true }], {
          force: true,
          backup: true,
        }),
        writeGeneratedFiles(root, [{ path: 'second.txt', content: 'second-after', managed: true }], {
          force: true,
          backup: true,
        }),
      ])
      return operation.backupId
    })

    expect(await readManifest(root, backupId)).toMatchObject({
      status: 'complete',
      entries: [
        { path: 'first.txt', state: 'modified' },
        { path: 'second.txt', state: 'modified' },
      ],
    })
  })

  it('merges earlier child snapshots when a parent path is registered later', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested/original.txt'), 'original', 'utf8')

    await expect(
      withProjectWriteLock(root, 'child then parent', async () => {
        await writeGeneratedFiles(root, [{ path: 'nested/original.txt', content: 'changed', managed: true }], {
          force: true,
          backup: true,
        })
        await trackProjectPathForBackup(root, 'nested')
        await writeFile(join(root, 'nested/created.txt'), 'created', 'utf8')
        throw new Error('rollback merged parent')
      }),
    ).rejects.toThrow('rollback merged parent')

    expect(await readFile(join(root, 'nested/original.txt'), 'utf8')).toBe('original')
    await expect(readFile(join(root, 'nested/created.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform !== 'win32')('treats Windows path casing as one backup identity', async () => {
    const root = await temporaryRoot()
    await writeFile(join(root, 'Case.txt'), 'original', 'utf8')
    let backupId = ''

    await expect(
      withProjectWriteLock(root, 'case-insensitive paths', async (operation) => {
        backupId = operation.backupId
        await writeGeneratedFiles(root, [{ path: 'Case.txt', content: 'intermediate', managed: true }], {
          force: true,
          backup: true,
        })
        await writeGeneratedFiles(root, [{ path: 'case.txt', content: 'final', managed: true }], {
          force: true,
          backup: true,
        })
        throw new Error('rollback casing')
      }),
    ).rejects.toThrow('rollback casing')

    expect(await readFile(join(root, 'Case.txt'), 'utf8')).toBe('original')
    expect((await readManifest(root, backupId)).entries).toHaveLength(1)
  })

  it.skipIf(process.platform !== 'win32')('rejects manifest aliases before changing a Windows target', async () => {
    const root = await temporaryRoot()
    const backupId = 'case-alias-backup'
    const backupRoot = join(root, '.create-maa-project', 'backups', backupId)
    await writeFile(join(root, 'Case.txt'), 'current', 'utf8')
    await mkdir(join(backupRoot, 'files'), { recursive: true })
    await writeFile(join(backupRoot, 'files/Case.txt'), 'backup', 'utf8')
    await writeFile(
      join(backupRoot, '.create-maa-project-backup.json'),
      `${JSON.stringify({
        format: 'create-maa-project-backup',
        schemaVersion: 1,
        id: backupId,
        createdAt: new Date().toISOString(),
        command: 'case alias',
        status: 'complete',
        entries: [
          { path: 'Case.txt', state: 'modified' },
          { path: 'case.txt', state: 'created' },
        ],
      })}\n`,
      'utf8',
    )

    await expect(restoreBackup(root, backupId)).rejects.toThrow('overlapping path')
    expect(await readFile(join(root, 'Case.txt'), 'utf8')).toBe('current')
  })

  it.skipIf(process.platform !== 'win32')('reuses a Windows write lock through differently cased roots', async () => {
    const root = await temporaryRoot()

    await withProjectWriteLock(root, 'outer casing', () =>
      withProjectWriteLock(root.toUpperCase(), 'inner casing', () =>
        writeGeneratedFiles(root, [{ path: 'created.txt', content: 'created', managed: true }], {
          force: true,
          backup: true,
        }),
      ),
    )

    expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('created')
  })

  it('expires inherited async lock contexts after their operation completes', async () => {
    const root = await temporaryRoot()
    let releaseDetached: (() => void) | undefined
    let detached: Promise<unknown> | undefined

    await withProjectWriteLock(root, 'schedule detached write', async () => {
      const gate = new Promise<void>((resolve) => {
        releaseDetached = resolve
      })
      detached = gate.then(() =>
        writeGeneratedFiles(root, [{ path: 'detached.txt', content: 'unsafe', managed: true }], {
          force: true,
          backup: true,
        }),
      )
    })

    let releaseSecond: (() => void) | undefined
    let markSecondStarted: (() => void) | undefined
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve
    })
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const second = withProjectWriteLock(root, 'hold second lock', async () => {
      markSecondStarted?.()
      await secondGate
    })
    await secondStarted
    releaseDetached?.()
    await expect(detached).rejects.toThrow('Another create-maa-project command is running')
    releaseSecond?.()
    await second
    await expect(readFile(join(root, 'detached.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('elects exactly one winner when write-lock claims start together', async () => {
    const root = await temporaryRoot()
    let markEntered: (() => void) | undefined
    let releaseWinner: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const winnerGate = new Promise<void>((resolve) => {
      releaseWinner = resolve
    })
    const contenders = [
      withProjectLock(root, 'first contender', async () => {
        markEntered?.()
        await winnerGate
      }),
      withProjectLock(root, 'second contender', async () => {
        markEntered?.()
        await winnerGate
      }),
    ].map((contender) =>
      contender.then(
        () => true,
        () => false,
      ),
    )

    await Promise.race([
      entered,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('No lock contender entered')), 2_000)),
    ])
    releaseWinner?.()
    const results = await Promise.all(contenders)

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(results.filter((result) => !result)).toHaveLength(1)
  })

  it('restores a legacy project file named manifest.json without treating it as backup metadata', async () => {
    const root = await temporaryRoot()
    const backupRoot = join(root, '.create-maa-project', 'backups', 'legacy-manifest-project')
    await mkdir(backupRoot, { recursive: true })
    await writeFile(join(backupRoot, 'manifest.json'), '{"project":true}\n', 'utf8')
    await writeFile(join(backupRoot, 'README.md'), '# Legacy\n', 'utf8')

    const result = await restoreBackup(root, 'legacy-manifest-project')

    expect(result.restored).toEqual(expect.arrayContaining(['manifest.json', 'README.md']))
    expect(await readFile(join(root, 'manifest.json'), 'utf8')).toBe('{"project":true}\n')
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# Legacy\n')
  })

  it('restores a legacy backup without modifying an external hard link', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    const outsideFile = join(outside, 'sentinel.txt')
    const projectFile = join(root, 'managed.txt')
    const backupRoot = join(root, '.create-maa-project', 'backups', 'legacy-hard-link')
    await writeFile(outsideFile, 'outside-before', 'utf8')
    await link(outsideFile, projectFile)
    await mkdir(backupRoot, { recursive: true })
    await writeFile(join(backupRoot, 'managed.txt'), 'restored', 'utf8')

    await restoreBackup(root, 'legacy-hard-link')

    expect(await readFile(projectFile, 'utf8')).toBe('restored')
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-before')
  })

  it('refuses to write through a project symlink or junction', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    await writeFile(join(outside, 'sentinel.txt'), 'outside-before', 'utf8')
    try {
      await symlink(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (isPermissionError(error)) return
      throw error
    }

    await expect(
      withProjectWriteLock(root, 'symlink write', () =>
        writeGeneratedFiles(root, [{ path: 'alias/sentinel.txt', content: 'outside-after', managed: true }], {
          force: true,
          backup: true,
        }),
      ),
    ).rejects.toThrow('symbolic link')
    expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside-before')
  })

  it('preserves relative symbolic-link targets through a backup round trip', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'node_modules/store'), { recursive: true })
    await writeFile(join(root, 'node_modules/store/package.txt'), 'package', 'utf8')
    try {
      await symlink('store/package.txt', join(root, 'node_modules/package.txt'), 'file')
    } catch (error) {
      if (isPermissionError(error)) return
      throw error
    }

    const backupId = await withProjectWriteLock(root, 'replace symlink tree', async (operation) => {
      await trackProjectPathForBackup(root, 'node_modules')
      await rm(join(root, 'node_modules/package.txt'))
      await writeFile(join(root, 'node_modules/package.txt'), 'replacement', 'utf8')
      return operation.backupId
    })
    await restoreBackup(root, backupId)

    expect((await readlink(join(root, 'node_modules/package.txt'))).replaceAll('\\', '/')).toBe('store/package.txt')
    expect(await readFile(join(root, 'node_modules/package.txt'), 'utf8')).toBe('package')
  })

  it('replaces a hard-linked managed file without modifying the other link', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    const outsideFile = join(outside, 'sentinel.txt')
    await writeFile(outsideFile, 'original', 'utf8')
    try {
      await link(outsideFile, join(root, 'managed.txt'))
    } catch (error) {
      if (isPermissionError(error)) return
      throw error
    }

    const result = await withProjectWriteLock(root, 'replace hard link', () =>
      writeGeneratedFiles(root, [{ path: 'managed.txt', content: 'generated', managed: true }], {
        force: true,
        backup: true,
      }),
    )

    expect(await readFile(join(root, 'managed.txt'), 'utf8')).toBe('generated')
    expect(await readFile(outsideFile, 'utf8')).toBe('original')
    await restoreBackup(root, result.backupId as string)
    expect(await readFile(join(root, 'managed.txt'), 'utf8')).toBe('original')
    expect(await readFile(outsideFile, 'utf8')).toBe('original')
  })

  it('backs up persistent runtime state while protecting internal backup state', async () => {
    const root = await temporaryRoot()
    const runtimeFile = '.create-maa-project/runtime/python/win-x64/python.exe'
    await mkdir(join(root, '.create-maa-project/runtime/python/win-x64'), { recursive: true })
    await writeFile(join(root, runtimeFile), 'old-runtime', 'utf8')

    const backupId = await withProjectWriteLock(root, 'replace runtime', async (operation) => {
      await writeGeneratedFiles(root, [{ path: runtimeFile, content: 'new-runtime', managed: true }], {
        force: true,
        backup: true,
      })
      return operation.backupId
    })

    expect(await readFile(join(root, runtimeFile), 'utf8')).toBe('new-runtime')
    await restoreBackup(root, backupId)
    expect(await readFile(join(root, runtimeFile), 'utf8')).toBe('old-runtime')
    await expect(
      withProjectWriteLock(root, 'protected state', () =>
        writeGeneratedFiles(root, [{ path: '.create-maa-project/backups/escape.txt', content: 'no', managed: true }], {
          force: true,
          backup: true,
        }),
      ),
    ).rejects.toThrow('Protected project state')
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-backup-'))
  temporaryRoots.push(root)
  return root
}

async function backupIds(root: string): Promise<string[]> {
  return (await readdir(join(root, '.create-maa-project', 'backups'))).sort()
}

async function readManifest(
  root: string,
  backupId: string,
): Promise<{
  schemaVersion: number
  id: string
  command: string
  status: string
  entries: Array<{ path: string; state: string }>
}> {
  return JSON.parse(
    await readFile(join(root, '.create-maa-project', 'backups', backupId, '.create-maa-project-backup.json'), 'utf8'),
  ) as {
    schemaVersion: number
    id: string
    command: string
    status: string
    entries: Array<{ path: string; state: string }>
  }
}

function backupFile(root: string, backupId: string, path: string): string {
  return join(root, '.create-maa-project', 'backups', backupId, 'files', path)
}

function isPermissionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'EPERM' || (error as { code?: unknown }).code === 'EACCES')
  )
}
