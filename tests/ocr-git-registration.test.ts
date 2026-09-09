import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { DEFAULT_OCR_FILES, DEFAULT_OCR_SUBMODULE_URL } from '../src/assets.js'
import { restoreBackup } from '../src/project.js'
import { createProject } from '../src/scaffold.js'
import { recordUpdateRequests } from '../src/update.js'
import { sha256 } from '../src/utils.js'

const execFileAsync = promisify(execFile)
const tempRoots: string[] = []
const modelContent = Buffer.from('fixture OCR model\n')

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OCR submodule registration', () => {
  it.each([false, true])(
    'uses tracked OCR downloads inside a parent repository (skipDownload=%s)',
    async (skipDownload) => {
      const { root, repository } = await fixtureRepositories()
      const originalModules = '# Parent repository submodules\n'
      await writeFile(join(repository, '.gitmodules'), originalModules)
      const originalIndex = await git(repository, ['ls-files', '--stage'])
      const options = parseArgs(['apps/child', '--no-interactive', ...(skipDownload ? ['--skip-download'] : [])])

      const result = await createProject(options, {
        cwd: repository,
        downloadOcrModels: true,
        ocrManifestResolver: async () => ({
          schemaVersion: 1,
          assets: DEFAULT_OCR_FILES.map((path) => ({
            path,
            url: `https://fixture.invalid/${path}`,
            sha256: sha256(modelContent),
            size: modelContent.byteLength,
          })),
        }),
        assetDownloader: async () => modelContent,
        gitRunner: async () => {
          throw new Error('A nested project must not clone a Git repository or change the parent index.')
        },
      })

      expect(result.config.ocr?.source).not.toBe('submodule')
      expect(result.git).toMatchObject({ initialized: false, committed: false })
      expect(await readFile(join(repository, '.gitmodules'), 'utf8')).toBe(originalModules)
      expect(await git(repository, ['ls-files', '--stage'])).toBe(originalIndex)
      await expect(stat(join(result.root, '.gitmodules'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(result.root, 'MaaCommonAssets'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(result.root, '.gitignore'), 'utf8')).not.toContain('resource/base/model/ocr/')
      expect(result.pending.some((item) => item.kind === 'ocr-model')).toBe(skipDownload)

      await git(repository, ['add', '.'])
      const trackedModels = await git(repository, ['ls-files', '--stage', 'apps/child/resource/base/model/ocr'])
      expect(trackedModels).toContain('100644 ')
      expect(trackedModels).toContain('apps/child/resource/base/model/ocr/det.onnx')
      expect(await git(repository, ['submodule', 'status'])).toBe('')
      await commit(repository)
      const checkout = join(root, 'checkout')
      await git(root, ['clone', '--recurse-submodules', repository, checkout])
      expect(await readFile(join(checkout, 'apps/child/resource/base/model/ocr/det.onnx'))).toEqual(
        skipDownload ? Buffer.alloc(0) : modelContent,
      )
    },
  )

  it('rejects an explicitly requested OCR submodule in a parent repository before writing project files', async () => {
    const { repository } = await fixtureRepositories()

    await expect(
      createProject(parseArgs(['child', '--no-interactive', '--skip-download']), {
        cwd: repository,
        ocrSource: 'submodule',
      }),
    ).rejects.toThrow('CREATE_MAA_PROJECT_OCR_SOURCE=download')

    expect(await readdir(join(repository, 'child'))).toEqual([])
    expect(await git(repository, ['status', '--porcelain'])).toBe('')
  })

  it('keeps submodule mode at a linked worktree root with a .git file', async () => {
    const { repository } = await fixtureRepositories()
    await writeFile(join(repository, 'existing.txt'), 'existing repository\n')
    await git(repository, ['add', '.'])
    await commit(repository)
    const worktree = join(repository, 'linked-worktree')
    await git(repository, ['worktree', 'add', '--detach', worktree])
    expect((await stat(join(worktree, '.git'))).isFile()).toBe(true)

    const result = await createProject(parseArgs(['.', '--force', '--no-interactive', '--skip-download']), {
      cwd: worktree,
    })

    expect(result.config.ocr?.source).toBe('submodule')
    expect(await readFile(join(worktree, '.gitmodules'), 'utf8')).toContain('path = MaaCommonAssets')
    await expect(stat(join(repository, '.gitmodules'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['other-assets', 'MaaCommonAssets'])(
    'preserves an existing %s submodule and registers OCR for a fresh clone',
    async (name) => {
      const { root, repository, models } = await fixtureRepositories()
      await git(repository, [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--name',
        name,
        models,
        'other-assets',
      ])
      const originalModules = await readFile(join(repository, '.gitmodules'), 'utf8')
      const originalIndex = await git(repository, ['ls-files', '--stage'])

      const result = await createProject(parseArgs(['.', '--force', '--no-interactive']), {
        cwd: repository,
        downloadOcrModels: true,
        gitRunner: async (cwd, args) => {
          await git(cwd, ['-c', `url.${pathToFileURL(models).href}.insteadOf=${DEFAULT_OCR_SUBMODULE_URL}`, ...args])
        },
      })

      expect(result.config.ocr?.source).toBe('submodule')
      expect(result.pending).toEqual([])
      expect(result.written).toContain('.gitmodules')
      expect(result.skipped).not.toContain('.gitmodules')
      expect(await readFile(join(repository, '.gitmodules'), 'utf8')).toContain(originalModules)
      expect(await git(repository, ['ls-files', '--stage'])).toBe(originalIndex)
      const modulePaths = await git(repository, [
        'config',
        '--file',
        '.gitmodules',
        '--get-regexp',
        '^submodule\..*\.path$',
      ])
      expect(modulePaths.trim().split('\n')).toHaveLength(2)
      expect(modulePaths).toContain(`submodule.${name}.path other-assets`)
      expect(modulePaths).toMatch(/submodule\.[^\n]+\.path MaaCommonAssets/)

      await git(repository, ['add', '.'])
      await commit(repository)
      const checkout = join(root, 'checkout')
      await git(root, [
        '-c',
        'protocol.file.allow=always',
        '-c',
        `url.${pathToFileURL(models).href}.insteadOf=${DEFAULT_OCR_SUBMODULE_URL}`,
        'clone',
        '--recurse-submodules',
        repository,
        checkout,
      ])
      expect((await git(checkout, ['submodule', 'status'])).trim().split('\n')).toHaveLength(2)
      await recordUpdateRequests(parseArgs(['--update', 'ocr-models']), { root: checkout })
      expect(await readFile(join(checkout, 'resource/base/model/ocr/det.onnx'))).toEqual(modelContent)
    },
    // Recursive local clones and provisioning exceed 15s on Windows with coverage.
    30_000,
  )

  it('preserves an existing OCR mapping and uses its configured URL', async () => {
    const { repository, models } = await fixtureRepositories()
    const originalModules = `[submodule "custom-ocr"]\n\tpath = MaaCommonAssets\n\turl = ${pathToFileURL(models).href}\n`
    await writeFile(join(repository, '.gitmodules'), originalModules)

    const result = await createProject(parseArgs(['.', '--force', '--no-interactive']), {
      cwd: repository,
      downloadOcrModels: true,
      gitRunner: async (cwd, args) => {
        if (args[0] === 'clone' && args[3] !== pathToFileURL(models).href) {
          throw new Error('The existing OCR submodule URL must be used.')
        }
        await git(cwd, args)
      },
    })

    expect(result.pending).toEqual([])
    expect(result.skipped).toContain('.gitmodules')
    expect(await readFile(join(repository, '.gitmodules'), 'utf8')).toBe(originalModules)
    expect(await readFile(join(repository, 'resource/base/model/ocr/det.onnx'))).toEqual(modelContent)
    await createProject(parseArgs(['.', '--force', '--no-interactive', '--skip-download']), { cwd: repository })
    expect(await readFile(join(repository, '.gitmodules'), 'utf8')).toBe(originalModules)
  })

  it('includes the merged Git configuration in the creation backup', async () => {
    const { repository } = await fixtureRepositories()
    const originalModules = '# Existing repository configuration without a final newline'
    await writeFile(join(repository, '.gitmodules'), originalModules)

    const result = await createProject(parseArgs(['.', '--force', '--no-interactive', '--skip-download']), {
      cwd: repository,
    })

    expect(result.written).toContain('.gitmodules')
    expect(await readFile(join(repository, '.gitmodules'), 'utf8')).toContain('path = MaaCommonAssets')
    expect(result.backupId).toBeDefined()
    await restoreBackup(repository, result.backupId!)
    expect(await readFile(join(repository, '.gitmodules'), 'utf8')).toBe(originalModules)
  })
})

async function fixtureRepositories(): Promise<{ root: string; repository: string; models: string }> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-ocr-git-'))
  tempRoots.push(root)
  const repository = join(root, 'repository')
  const models = join(root, 'models')
  await mkdir(repository)
  await mkdir(join(models, 'OCR/ppocr_v6/small'), { recursive: true })
  for (const name of DEFAULT_OCR_FILES) {
    await writeFile(join(models, 'OCR/ppocr_v6/small', name), modelContent)
  }
  // Keep the local fixtures byte-identical on Windows as well as Unix.
  await writeFile(join(models, '.gitattributes'), '* -text\n')
  await git(models, ['init'])
  await git(models, ['add', '.'])
  await commit(models)
  await git(repository, ['init'])
  await git(repository, ['config', 'core.autocrlf', 'false'])
  return { root, repository, models }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true })
  return stdout.replaceAll('\r\n', '\n')
}

async function commit(cwd: string): Promise<void> {
  await git(cwd, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'fixture'])
}
