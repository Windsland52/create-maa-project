import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDoctor } from '../src/doctor.js'
import { applyIncrementalAddons } from '../src/incremental-addons.js'
import { addAgent, createProject } from '../src/scaffold.js'
import type { CliOptions } from '../src/types.js'

const execFileAsync = promisify(execFile)

const ANDROID_ADDON_FILES = [
  'Android/README.md',
  'Android/profile.yaml',
  '.github/workflows/android-build.yml',
  '.github/workflows/android.yml',
  'tools/android-packaging.mjs',
]

const tempRoots: string[] = []
let previousCwd = process.cwd()

beforeEach(() => {
  previousCwd = process.cwd()
})

afterEach(async () => {
  process.chdir(previousCwd)
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function options(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    template: 'pipeline',
    add: [],
    update: [],
    doctor: false,
    yes: true,
    noInteractive: true,
    force: false,
    clearStaleLock: false,
    allowNonGitDir: false,
    allowPendingCommit: false,
    skipDownload: true,
    verbose: false,
    noColor: false,
    assist: false,
    dryRun: false,
    listBackups: false,
    cleanCache: false,
    report: false,
    mcp: false,
    explicitTemplate: false,
    initializeGit: false,
    ...overrides,
  }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-android-addon-'))
  tempRoots.push(root)
  return root
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** A pipeline project with the GitHub add-on and no OCR download, ready for `--add android`. */
async function scaffoldProject(root: string, name: string, add: string[] = []): Promise<string> {
  await createProject(options({ name, add }), { cwd: root })
  return join(root, name)
}

/** A nested Git repository is what `git add` records as a gitlink. */
async function createShellRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await execFileAsync('git', ['init'], { cwd: path })
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=CMP Tests',
      '-c',
      'user.email=cmp-tests@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'shell',
    ],
    { cwd: path },
  )
}

describe('android add-on: project creation', () => {
  it('writes the documented file set and pairs it with the pipeline recipe', async () => {
    const root = await tempRoot()
    const projectRoot = await scaffoldProject(root, 'maa-android-pipeline', [
      'github',
      'android',
    ])

    for (const path of ANDROID_ADDON_FILES) {
      expect(await readIfPresent(join(projectRoot, path)), path).toBeDefined()
    }

    const profile = await readFile(join(projectRoot, 'Android/profile.yaml'), 'utf8')
    expect(profile).toContain('assets: ..')
    // The shell turns app.id into package segments and rejects hyphens.
    expect(profile).toContain('id: maa_android_pipeline')
    // The pipeline recipe relies on MaaFwApp's built-in include whitelist and packages no agent.
    expect(profile).not.toMatch(/^agent:/m)
    expect(profile).not.toMatch(/^include:/m)

    // GitHub automation is a soft integration: the release hook is there, the entry workflow is the
    // add-on's own file.
    const release = await readFile(join(projectRoot, '.github/workflows/release.yml'), 'utf8')
    expect(release).toContain('needs: [package, android]')
    expect(release).toContain('release-assets/*.apk')
  })

  it('chooses the agent recipe and asks for an exact maafw version', async () => {
    const root = await tempRoot()
    await createProject(options({ name: 'maa-android-agent', template: 'agent', add: ['android'] }), { cwd: root })
    const projectRoot = join(root, 'maa-android-agent')

    const profile = await readFile(join(projectRoot, 'Android/profile.yaml'), 'utf8')
    expect(profile).toMatch(/^agent:$/m)
    expect(profile).toContain('sourceDir: agent-dist')
    // The default whitelist is replaced wholesale, so the agent payload has to be listed.
    expect(profile).toMatch(/^include:$/m)
    expect(profile).toContain('  - agent/**')

    const config = JSON.parse(await readFile(join(projectRoot, 'maa-project.json'), 'utf8')) as {
      addons: Record<string, unknown>
    }
    expect(config.addons.android).toEqual({ enabled: true })
  })

  it('does not ask for a version pin for a pipeline project', async () => {
    // The pending action is about the agent's Python binding; a pipeline package has none.
    const root = await tempRoot()
    const projectRoot = await scaffoldProject(root, 'maa-android-noagent', ['android'])
    const result = await applyIncrementalAddons(options({ add: ['android'] }), () => {}, projectRoot)

    expect(result?.pending.map((item) => item.kind) ?? []).not.toContain('android-version')
  })

  it('scopes the Agent project ruff run away from the vendored shell', async () => {
    const root = await tempRoot()
    await createProject(options({ name: 'maa-android-ruff', template: 'agent', add: ['android'] }), { cwd: root })

    const pyproject = await readFile(join(root, 'maa-android-ruff', 'pyproject.toml'), 'utf8')
    // Every release package job runs `pnpm check:py` after checking out submodules, so upstream's
    // coding comments would fail the whole release before packaging starts.
    expect(pyproject).toContain('extend-exclude = ["Android/MaaFwApp"]')
  })
})

describe('android add-on: --add agent on a shell project', () => {
  it('gives the Agent project the ruff exclusion when it is added to a shell project', async () => {
    const root = await tempRoot()
    const projectRoot = await scaffoldProject(root, 'maa-android-then-agent', [
      'github',
      'vscode',
      'android',
    ])
    expect(await readIfPresent(join(projectRoot, 'pyproject.toml'))).toBeUndefined()

    await addAgent(options({ add: ['agent'] }), projectRoot)

    const pyproject = await readFile(join(projectRoot, 'pyproject.toml'), 'utf8')
    expect(pyproject).toContain('extend-exclude = ["Android/MaaFwApp"]')
  })

  it('repairs a pyproject.toml that predates the exclusion', async () => {
    const root = await tempRoot()
    await createProject(options({ name: 'maa-android-ruff-repair', template: 'agent', add: ['android'] }), {
      cwd: root,
    })
    const projectRoot = join(root, 'maa-android-ruff-repair')
    const pyprojectPath = join(projectRoot, 'pyproject.toml')
    // A project created before the template carried the line.
    const stripped = (await readFile(pyprojectPath, 'utf8'))
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('# Android/MaaFwApp') && !line.startsWith('extend-exclude'))
      .join('\n')
    await writeFile(pyprojectPath, stripped, 'utf8')

    const result = await addAgent(options({ add: ['agent'] }), projectRoot)

    expect(result.written).toContain('pyproject.toml')
    expect(await readFile(pyprojectPath, 'utf8')).toContain('extend-exclude = ["Android/MaaFwApp"]')
  })
})

describe('android add-on: --add android on an existing project', () => {
  it('appends the runtime ignore line and reports the pending shell checkout under --skip-download', async () => {
    const root = await tempRoot()
    const projectRoot = await scaffoldProject(root, 'maa-android-add', ['github'])
    const result = await applyIncrementalAddons(options({ add: ['android'] }), () => {}, projectRoot)

    expect(result?.written).toEqual(expect.arrayContaining(ANDROID_ADDON_FILES))
    const gitignore = await readFile(join(projectRoot, '.gitignore'), 'utf8')
    expect(gitignore).toContain('Android/agent-dist/')
    // The release workflow of the project is refreshed with the android job and the APK assets.
    const release = await readFile(join(projectRoot, '.github/workflows/release.yml'), 'utf8')
    expect(release).toContain('needs: [package, android]')
    expect(release).toContain('release-assets/*.apk')
    expect(
      gitignore.split(/\r?\n/).filter((line) => line.trim() === 'Android/agent-dist/'),
      'the ignore line must appear once',
    ).toHaveLength(1)

    const pending = result?.pending.find((item) => item.kind === 'android-submodule')
    expect(pending?.command).toBe(
      'git submodule add -b main https://github.com/Aliothmoon/MaaFwApp.git Android/MaaFwApp',
    )
    // Nothing was checked out, so no registration either: the recovery command has to be able to
    // run, and it is the step that appends the section.
    expect(await readFile(join(projectRoot, '.gitmodules'), 'utf8')).not.toContain('Android/MaaFwApp')
    expect(await readIfPresent(join(projectRoot, 'Android/MaaFwApp/.git'))).toBeUndefined()
  })

  it('registers the shell, stages its gitlink, keeps doctor happy and stays idempotent', async () => {
    const root = await tempRoot()
    const projectRoot = await scaffoldProject(root, 'maa-android-shell', ['github'])
    await execFileAsync('git', ['init'], { cwd: projectRoot })
    await createShellRepository(join(projectRoot, 'Android/MaaFwApp'))
    const runOptions = options({ add: ['android'], skipDownload: false })

    const result = await applyIncrementalAddons(runOptions, () => {}, projectRoot)

    const gitmodules = await readFile(join(projectRoot, '.gitmodules'), 'utf8')
    expect(gitmodules).toContain('[submodule "Android/MaaFwApp"]')
    expect(gitmodules).toContain('\tpath = Android/MaaFwApp')
    expect(gitmodules).toContain('\turl = https://github.com/Aliothmoon/MaaFwApp.git')
    // `branch` is what `git submodule update --remote` follows when the shell moves on main.
    expect(gitmodules).toContain('\tbranch = main')
    // The OCR submodule section the base template wrote is kept.
    expect(gitmodules).toContain('[submodule "MaaCommonAssets"]')
    expect(result?.written).toContain('.gitmodules')
    expect(result?.pending.map((item) => item.kind) ?? []).not.toContain('android-submodule')

    // CI checks out submodules recursively, which needs mode 160000 in the index and the URL in
    // `.gitmodules`.
    const { stdout } = await execFileAsync('git', ['ls-files', '--stage', 'Android/MaaFwApp'], { cwd: projectRoot })
    expect(stdout.trim().startsWith('160000')).toBe(true)
    const gitmodulesIndex = await execFileAsync('git', ['ls-files', '--stage', '.gitmodules'], { cwd: projectRoot })
    expect(gitmodulesIndex.stdout.trim()).not.toBe('')

    const report = await runDoctor(projectRoot)
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'android-packaging',
          status: 'pass',
        }),
      ]),
    )
    expect(report.lines).toContain('[OK] Android packaging files, shell checkout and version pin are consistent.')

    // A second run sees the registration and the ignore line already in place.
    const firstIgnore = await readFile(join(projectRoot, '.gitignore'), 'utf8')
    const second = await applyIncrementalAddons(runOptions, () => {}, projectRoot)
    expect(await readFile(join(projectRoot, '.gitmodules'), 'utf8')).toBe(gitmodules)
    expect(await readFile(join(projectRoot, '.gitignore'), 'utf8')).toBe(firstIgnore)
    expect(second?.written).not.toContain('.gitmodules')
    expect(second?.written).not.toContain('.gitignore')
  })

  it('adds the ruff exclusion to a pyproject.toml the project already owns', async () => {
    const root = await tempRoot()
    await createProject(options({ name: 'maa-android-ruff-add', template: 'agent' }), { cwd: root })
    const projectRoot = join(root, 'maa-android-ruff-add')
    const pyprojectPath = join(projectRoot, 'pyproject.toml')
    const before = await readFile(pyprojectPath, 'utf8')
    expect(before).not.toContain('extend-exclude')

    const result = await applyIncrementalAddons(options({ add: ['android'] }), () => {}, projectRoot)

    const patched = await readFile(pyprojectPath, 'utf8')
    expect(result?.written).toContain('pyproject.toml')
    expect(patched).toContain('extend-exclude = ["Android/MaaFwApp"]')
    // Everything the project owned survives: --update python-deps reads [project].dependencies.
    expect(patched).toContain('dependencies = [\n    "loguru",\n    "maafw",\n]')

    const second = await applyIncrementalAddons(options({ add: ['android'] }), () => {}, projectRoot)
    expect(second?.written).not.toContain('pyproject.toml')
    expect(await readFile(pyprojectPath, 'utf8')).toBe(patched)
  })

  it('merges the shell into an extend-exclude the project already owns', async () => {
    const root = await tempRoot()
    await createProject(options({ name: 'maa-android-ruff-merge', template: 'agent' }), { cwd: root })
    const projectRoot = join(root, 'maa-android-ruff-merge')
    const pyprojectPath = join(projectRoot, 'pyproject.toml')
    const current = await readFile(pyprojectPath, 'utf8')
    await writeFile(
      pyprojectPath,
      current.replace('line-length = 120', 'line-length = 120\nextend-exclude = ["scripts"]'),
      'utf8',
    )

    await applyIncrementalAddons(options({ add: ['android'] }), () => {}, projectRoot)

    const patched = await readFile(pyprojectPath, 'utf8')
    expect(patched).toContain('extend-exclude = ["scripts", "Android/MaaFwApp"]')
    // A second key would be invalid TOML and would break --update python-deps (it parses this file).
    expect(patched.split('\n').filter((line) => /^\s*extend-exclude\s*=/u.test(line))).toHaveLength(1)
  })

  it('repairs a pyproject.toml that already stacked the shell-only key', async () => {
    const root = await tempRoot()
    await createProject(options({ name: 'maa-android-ruff-repair-dupe', template: 'agent' }), { cwd: root })
    const projectRoot = join(root, 'maa-android-ruff-repair-dupe')
    const pyprojectPath = join(projectRoot, 'pyproject.toml')
    const broken = (await readFile(pyprojectPath, 'utf8')).replace(
      'line-length = 120',
      'line-length = 120\nextend-exclude = ["scripts"]\nextend-exclude = ["Android/MaaFwApp"]',
    )
    await writeFile(pyprojectPath, broken, 'utf8')

    await applyIncrementalAddons(options({ add: ['android'] }), () => {}, projectRoot)

    const repaired = await readFile(pyprojectPath, 'utf8')
    expect(repaired.split('\n').filter((line) => /^\s*extend-exclude\s*=/u.test(line))).toHaveLength(1)
    expect(repaired).toContain('"scripts"')
    expect(repaired).toContain('"Android/MaaFwApp"')
  })

  it('pins an exact maafw version into pyproject.toml and waits for the export', async () => {
    const root = await tempRoot()
    await createProject(options({ name: 'maa-android-pin', template: 'agent', add: ['android'] }), { cwd: root })
    const projectRoot = join(root, 'maa-android-pin')

    // A fresh Agent package has no pin yet, because only `uv export` can produce one: doctor says so.
    const before = await runDoctor(projectRoot)
    expect(before.lines).toContain(
      '[ERR] requirements.txt has no exact maafw pin, so the Android bundle cannot be paired with a kernel release.',
    )

    const configPath = join(projectRoot, 'maa-project.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { maafw: { version: string } }
    config.maafw.version = '5.13.0'
    await writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`, 'utf8')

    const result = await applyIncrementalAddons(options({ add: ['android'] }), () => {}, projectRoot)

    const pyproject = await readFile(join(projectRoot, 'pyproject.toml'), 'utf8')
    expect(pyproject).toContain('"maafw==5.13.0",')
    expect(result?.written).toContain('pyproject.toml')
    // requirements.txt is uv's output: the resolver reads it, and only `uv export` moves it.
    expect(await readFile(join(projectRoot, 'requirements.txt'), 'utf8')).toMatch(/^maafw$/m)
    expect(result?.pending.map((item) => item.kind) ?? []).toContain('android-version')
  })

  it('re-pins an existing maafw pin when maafw.version changes', async () => {
    const root = await tempRoot()
    await createProject(options({ name: 'maa-android-repin', template: 'agent', add: ['android'] }), { cwd: root })
    const projectRoot = join(root, 'maa-android-repin')
    const configPath = join(projectRoot, 'maa-project.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { maafw: { version: string } }
    config.maafw.version = '5.15.0-beta.1'
    await writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`, 'utf8')

    await applyIncrementalAddons(options({ add: ['android'] }), () => {}, projectRoot)
    expect(await readFile(join(projectRoot, 'pyproject.toml'), 'utf8')).toContain('"maafw==5.15.0-beta.1"')

    config.maafw.version = '5.15.0'
    await writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`, 'utf8')
    await applyIncrementalAddons(options({ add: ['android'] }), () => {}, projectRoot)
    expect(await readFile(join(projectRoot, 'pyproject.toml'), 'utf8')).toContain('"maafw==5.15.0"')
  })
})

describe('android add-on: doctor', () => {
  it('reports a registered shell that was never checked out', async () => {
    const root = await tempRoot()
    const projectRoot = await scaffoldProject(root, 'maa-android-doctor-empty', [
      'android',
    ])
    const gitmodulesPath = join(projectRoot, '.gitmodules')
    const current = await readFile(gitmodulesPath, 'utf8')
    await writeFile(
      gitmodulesPath,
      `${current}[submodule "Android/MaaFwApp"]\n\tpath = Android/MaaFwApp\n\turl = https://github.com/Aliothmoon/MaaFwApp.git\n\tbranch = main\n`,
      'utf8',
    )

    const report = await runDoctor(projectRoot)

    expect(report.lines).toContain('      To fix: git submodule update --init --depth 1 Android/MaaFwApp')
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'android-packaging',
          status: 'fail',
        }),
      ]),
    )
  })

  it('accepts the pep 440 beta pin and the release spelling as the same version', async () => {
    const root = await tempRoot()
    await createProject(options({ name: 'maa-android-beta-pin', template: 'agent', add: ['android'] }), {
      cwd: root,
    })
    const projectRoot = join(root, 'maa-android-beta-pin')
    await execFileAsync('git', ['init'], { cwd: projectRoot })
    await createShellRepository(join(projectRoot, 'Android/MaaFwApp'))

    const configPath = join(projectRoot, 'maa-project.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { maafw: { version: string } }
    config.maafw.version = '5.15.0-beta.1'
    await writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`, 'utf8')
    await applyIncrementalAddons(options({ add: ['android'], skipDownload: false }), () => {}, projectRoot)
    // `uv export` writes the PEP 440-normalized form; the release tag keeps the released one.
    await writeFile(join(projectRoot, 'requirements.txt'), 'maafw==5.15.0b1\n', 'utf8')

    const report = await runDoctor(projectRoot)

    expect(report.lines).toContain('[OK] Android packaging files, shell checkout and version pin are consistent.')
  })

  it('rejects an app id the shell cannot turn into package segments', async () => {
    const root = await tempRoot()
    const projectRoot = await scaffoldProject(root, 'maa-android-doctor-id', [
      'android',
    ])
    const profilePath = join(projectRoot, 'Android/profile.yaml')
    const profile = await readFile(profilePath, 'utf8')
    await writeFile(profilePath, profile.replace(/^( {2}id: )\S+$/m, '$1maa-helper'), 'utf8')

    const report = await runDoctor(projectRoot)

    expect(report.lines).toContain('[ERR] Android/profile.yaml declares app.id "maa-helper", which the shell rejects.')
    expect(report.lines).toContain(
      '      To fix: use lowercase package segments such as maa_helper (letters, digits and underscores).',
    )
  })
})

describe('android add-on: creation checks out the shell', () => {
  it('clones the shell through the command runner and leaves no pending action', async () => {
    const root = await tempRoot()
    const commands: string[][] = []
    const result = await createProject(
      options({
        name: 'maa-android-clone',
        add: [
          'android',
        ],
        initializeGit: true,
        skipDownload: false,
      }),
      {
        cwd: root,
        commandRunner: async (cwd, command, args) => {
          commands.push([
            command,
            ...args,
          ])
          if (command === 'git' && args[0] === 'clone') {
            await createShellRepository(join(cwd, 'Android/MaaFwApp'))
            return
          }
          throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
        },
      },
    )

    expect(commands).toEqual([
      [
        'git',
        'clone',
        '--depth',
        '1',
        'https://github.com/Aliothmoon/MaaFwApp.git',
        'Android/MaaFwApp',
      ],
    ])
    expect(result.pending.map((item) => item.kind)).not.toContain('android-submodule')
    const gitmodules = await readFile(join(result.root, '.gitmodules'), 'utf8')
    expect(gitmodules).toContain('\tpath = Android/MaaFwApp')

    const { stdout } = await execFileAsync('git', ['ls-files', '--stage', 'Android/MaaFwApp'], { cwd: result.root })
    expect(stdout.trim().startsWith('160000')).toBe(true)
    const gitmodulesIndex = await execFileAsync('git', ['ls-files', '--stage', '.gitmodules'], { cwd: result.root })
    expect(gitmodulesIndex.stdout.trim()).not.toBe('')
  })

  it('degrades a failed checkout into a pending action instead of failing creation', async () => {
    const root = await tempRoot()
    const result = await createProject(
      options({
        name: 'maa-android-clone-fails',
        add: [
          'android',
        ],
        skipDownload: false,
      }),
      {
        cwd: root,
        commandRunner: async () => {
          throw new Error('network is unreachable')
        },
      },
    )

    expect(result.pending.map((item) => item.kind)).toContain('android-submodule')
    // The recipe and the workflows are still written: only the checkout is missing.
    expect(await readIfPresent(join(result.root, 'Android/profile.yaml'))).toBeDefined()
    expect(await readFile(join(result.root, '.gitmodules'), 'utf8')).not.toContain('Android/MaaFwApp')
  })

  it('asks the owning repository to register the submodule when the project is nested', async () => {
    const root = await tempRoot()
    await execFileAsync('git', ['init'], { cwd: root })
    const result = await createProject(
      options({
        name: 'maa-android-nested',
        add: [
          'android',
        ],
        initializeGit: true,
        skipDownload: false,
      }),
      {
        cwd: root,
        commandRunner: async (cwd, command, args) => {
          if (command === 'git' && args[0] === 'clone') {
            await createShellRepository(join(cwd, 'Android/MaaFwApp'))
            return
          }
          throw new Error(`unexpected command: ${command} ${args.join(' ')}`)
        },
      },
    )

    // Git reads `.gitmodules` at the worktree root, which is the parent here, so nothing is staged.
    const pending = result.pending.find((item) => item.kind === 'android-submodule')
    expect(pending?.reason).toContain('does not own a Git repository')
    expect(pending?.command).toBe('git add .gitmodules Android/MaaFwApp')
    const { stdout } = await execFileAsync('git', ['ls-files', '--stage'], { cwd: root })
    expect(stdout.trim()).toBe('')
  })
})
