import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject, type GitRunner } from '../src/scaffold.js'
import type { CliOptions } from '../src/types.js'

const tempRoots: string[] = []
let previousCwd = process.cwd()

beforeEach(() => {
  previousCwd = process.cwd()
})

afterEach(async () => {
  process.chdir(previousCwd)
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Git initialization after project creation', () => {
  it('returns the created project when git init fails', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const commands: string[][] = []
    const gitRunner: GitRunner = async (_cwd, args) => {
      commands.push(args)
      throw new Error('git executable is unavailable')
    }

    const result = await createProject(createOptions('git-init-failure'), {
      gitRunner,
      detectGitTree: async () => false,
    })

    expect(result.git).toMatchObject({
      initialized: false,
      committed: false,
    })
    expect(result.git?.reason).toContain('git init failed: git executable is unavailable')
    expect(result.git?.reason).toContain('run git init and create the initial commit manually')
    expect(commands).toEqual([
      [
        'init',
      ],
    ])
    await expect(readFile(join(result.root, 'maa-project.json'), 'utf8')).resolves.toContain('git-init-failure')
  })

  it('returns the initialized project with staged files when git commit fails', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const commands: string[][] = []
    const gitRunner: GitRunner = async (cwd, args) => {
      commands.push(args)
      if (args[0] === 'init') {
        await mkdir(join(cwd, '.git/info'), { recursive: true })
        await writeFile(join(cwd, '.git/info/exclude'), '# custom exclude\n', 'utf8')
      }
      if (args[0] === 'commit') throw new Error('Author identity unknown')
    }

    const result = await createProject(createOptions('git-commit-failure'), {
      gitRunner,
      detectGitTree: async () => false,
    })

    expect(result.git).toMatchObject({
      initialized: true,
      committed: false,
    })
    expect(result.git?.reason).toContain('git commit failed: Author identity unknown')
    expect(result.git?.reason).toContain('configure Git user.name and user.email')
    expect(commands).toEqual([
      [
        'init',
      ],
      [
        'add',
        '--all',
        '--',
        '.',
        ':(exclude).create-maa-project',
        ':(exclude).create-maa-project/**',
        ':(exclude)node_modules',
        ':(exclude)node_modules/**',
      ],
      [
        'commit',
        '-m',
        'chore: scaffold MaaFW project',
      ],
    ])
    await expect(readFile(join(result.root, '.git/info/exclude'), 'utf8')).resolves.toBe(
      '# custom exclude\n/.create-maa-project/\n/node_modules/\n',
    )
    await expect(readFile(join(result.root, 'interface.json'), 'utf8')).resolves.toContain('git-commit-failure')
  })

  it('removes a partial repository when git init fails after creating .git', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const gitRunner: GitRunner = async (cwd) => {
      await mkdir(join(cwd, '.git'))
      throw new Error('post-init configuration failed')
    }

    const result = await createProject(createOptions('git-partial-init'), {
      gitRunner,
      detectGitTree: async () => false,
    })

    expect(result.git).toMatchObject({
      initialized: false,
      committed: false,
    })
    expect(result.git?.reason).toContain('Any newly created partial .git directory was removed')
    expect(result.git?.reason).toContain('run git init and create the initial commit manually')
    await expect(lstat(join(result.root, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns the initialized project when staging fails', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const commands: string[][] = []
    const gitRunner: GitRunner = async (_cwd, args) => {
      commands.push(args)
      if (args[0] === 'add') throw new Error('index is locked')
    }

    const result = await createProject(createOptions('git-add-failure'), {
      gitRunner,
      detectGitTree: async () => false,
    })

    expect(result.git).toMatchObject({
      initialized: true,
      committed: false,
    })
    expect(result.git?.reason).toContain('git add . failed: index is locked')
    expect(result.git?.reason).toContain('git add . and git commit manually')
    expect(commands).toEqual([
      [
        'init',
      ],
      [
        'add',
        '--all',
        '--',
        '.',
        ':(exclude).create-maa-project',
        ':(exclude).create-maa-project/**',
        ':(exclude)node_modules',
        ':(exclude)node_modules/**',
      ],
    ])
  })

  it('initializes Git by default when the target is outside a Git tree', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const commands: string[][] = []
    const gitRunner: GitRunner = async (cwd, args) => {
      commands.push(args)
      if (args[0] === 'init') {
        await mkdir(join(cwd, '.git/info'), { recursive: true })
        await writeFile(join(cwd, '.git/info/exclude'), '# custom exclude\n', 'utf8')
      }
    }

    const result = await createProject(createOptions('maa-git-default'), {
      gitRunner,
      detectGitTree: async () => false,
    })

    expect(result.git).toEqual({
      initialized: true,
      committed: true,
    })
    expect(commands.map((command) => command[0])).toEqual(['init', 'add', 'commit'])
  })

  it('reports skipped initialization when an unset default lands inside a Git tree', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const commands: string[][] = []
    const gitRunner: GitRunner = async (_cwd, args) => {
      commands.push(args)
    }

    const result = await createProject(createOptions('maa-git-in-tree'), {
      gitRunner,
      detectGitTree: async () => true,
    })

    expect(result.git).toEqual({
      initialized: false,
      committed: false,
      reason: 'target is inside an existing Git repository',
    })
    expect(commands).toEqual([])
  })

  it('initializes Git when explicitly enabled with initializeGit: true', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const commands: string[][] = []
    const gitRunner: GitRunner = async (cwd, args) => {
      commands.push(args)
      if (args[0] === 'init') {
        await mkdir(join(cwd, '.git/info'), { recursive: true })
        await writeFile(join(cwd, '.git/info/exclude'), '# custom exclude\n', 'utf8')
      }
    }

    const result = await createProject(createOptions('maa-git-explicit', { initializeGit: true }), {
      gitRunner,
      detectGitTree: async () => false,
    })

    expect(result.git).toEqual({
      initialized: true,
      committed: true,
    })
    expect(commands.map((command) => command[0])).toEqual(['init', 'add', 'commit'])
  })

  it('reports skipped initialization when explicitly enabled inside a Git tree', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const commands: string[][] = []
    const gitRunner: GitRunner = async (_cwd, args) => {
      commands.push(args)
    }

    const result = await createProject(createOptions('maa-git-explicit-in-tree', { initializeGit: true }), {
      gitRunner,
      detectGitTree: async () => true,
    })

    expect(result.git).toEqual({
      initialized: false,
      committed: false,
      reason: 'target is inside an existing Git repository',
    })
    expect(commands).toEqual([])
  })

  it('skips Git silently when initialization is explicitly disabled', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const commands: string[][] = []
    const gitRunner: GitRunner = async (_cwd, args) => {
      commands.push(args)
    }

    const result = await createProject(createOptions('maa-git-disabled', { initializeGit: false }), {
      gitRunner,
      detectGitTree: async () => false,
    })

    expect(result.git).toBeUndefined()
    expect(commands).toEqual([])
  })

  it('reports a missing git executable without failing the create', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const gitRunner: GitRunner = async () => {
      throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    }

    const result = await createProject(createOptions('maa-git-missing'), {
      gitRunner,
      detectGitTree: async () => false,
    })

    expect(result.git).toMatchObject({
      initialized: false,
      committed: false,
    })
    expect(result.git?.reason).toContain('git is not installed or not available on PATH')
    expect(result.git?.reason).toContain('install Git, then run git init')
    await expect(readFile(join(result.root, 'maa-project.json'), 'utf8')).resolves.toContain('maa-git-missing')
  })

  it('reports a missing git executable when wrapped in a message without code property', async () => {
    const root = await tempRoot()
    process.chdir(root)
    const gitRunner: GitRunner = async () => {
      throw new Error('Failed to run git init. spawn git ENOENT')
    }

    const result = await createProject(createOptions('maa-git-missing-message'), {
      gitRunner,
      detectGitTree: async () => false,
    })

    expect(result.git).toMatchObject({
      initialized: false,
      committed: false,
    })
    expect(result.git?.reason).toContain('git is not installed or not available on PATH')
    await expect(readFile(join(result.root, 'maa-project.json'), 'utf8')).resolves.toContain('maa-git-missing-message')
  })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-git-init-'))
  tempRoots.push(root)
  return root
}

function createOptions(name: string, overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    name,
    template: 'pipeline',
    add: [],
    update: [],
    doctor: false,
    yes: true,
    noInteractive: true,
    force: false,
    clearStaleLock: false,
    allowNonGitDir: false,
    allowPendingCommit: true,
    skipDownload: true,
    verbose: false,
    noColor: false,
    assist: false,
    dryRun: false,
    listBackups: false,
    cleanCache: false,
    report: false,
    mcp: false,
    explicitTemplate: true,
    ...overrides,
  }
}
