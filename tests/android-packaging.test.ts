import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { releaseArtifactName } from '../src/templates.js'

const execFileAsync = promisify(execFile)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const script = join(repoRoot, 'templates', 'addons', 'android', 'tools', 'android-packaging.mjs')

const CORE_TAGS = [
  '3.13.14-maafw5.12.3',
  '3.13.15-maafw5.12.3',
  '3.13.15-maafw5.13.0',
  '3.13.15-maafw4.11.0',
  '3.13.15-maafw5.15.0-beta.1',
]
const MAAFW_RELEASES = [
  { tag: 'v5.15.0-beta.1', prerelease: true },
  { tag: 'v5.14.2', prerelease: false },
  { tag: 'v5.13.0', prerelease: false },
]
const CHAQUOPY_INDEX_3_13 = 'https://chaquo.com/pypi-13.1/'

type ProjectFiles = {
  displayName?: string
  slug?: string
  maafwVersion?: string
  channel?: string
  ocr?: boolean
  agent?: boolean
  requirements?: string
}

type Outputs = Record<string, string>
type RunResult = { code: number; stdout: string; stderr: string; outputs: Outputs }

let fixtureDir: string
let fixtureFile: string
let chaquopyFixtureFile: string
let workRoot: string
let runCount = 0

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'cmp-android-fixture-'))
  workRoot = await mkdtemp(join(tmpdir(), 'cmp-android-'))
  fixtureFile = join(fixtureDir, 'releases.json')
  chaquopyFixtureFile = join(fixtureDir, 'chaquopy.json')
  await writeFile(fixtureFile, JSON.stringify({ core: CORE_TAGS, maafw: MAAFW_RELEASES }), 'utf8')
  await writeFile(
    chaquopyFixtureFile,
    JSON.stringify({
      // 文件名形状照抄真实索引：build tag（-0-）、平台标签，以及早期版本的大写发行名
      pillow: [
        'pillow-11.0.0-0-cp313-cp313-android_24_arm64_v8a.whl',
        'pillow-10.4.0-0-cp313-cp313-android_24_arm64_v8a.whl',
        'Pillow-10.1.0-0-cp312-cp312-android_24_arm64_v8a.whl',
      ],
      'opencv-python': [
        'opencv_python-4.10.0-0-cp312-cp312-android_24_arm64_v8a.whl',
      ],
      cryptography: [
        'Cryptography-42.0.0-0-cp313-cp313-android_24_arm64_v8a.whl',
      ],
    }),
    'utf8',
  )
})

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true })
  await rm(workRoot, { recursive: true, force: true })
})

async function writeProject(name: string, files: ProjectFiles): Promise<string> {
  const root = join(workRoot, name)
  await mkdir(root, { recursive: true })
  const project: Record<string, unknown> = {
    project: { displayName: files.displayName ?? 'My Pi', slug: files.slug ?? 'my-pi' },
    maafw: { channel: files.channel ?? 'stable', version: files.maafwVersion ?? '' },
  }
  if (files.ocr) project.ocr = { source: 'submodule' }
  await writeFile(join(root, 'maa-project.json'), JSON.stringify(project), 'utf8')
  await writeFile(
    join(root, 'interface.json'),
    JSON.stringify(files.agent ? { agent: [{ name: 'main' }] } : {}),
    'utf8',
  )
  if (files.requirements !== undefined) {
    await writeFile(join(root, 'requirements.txt'), files.requirements, 'utf8')
  }
  return root
}

async function readOutputs(path: string): Promise<Outputs> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  const outputs: Outputs = {}
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=')
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return outputs
}

async function runResolver(root: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const outputFile = join(workRoot, `github-output-${++runCount}.txt`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANDROID_PACKAGING_RELEASES_FIXTURE: fixtureFile,
    ANDROID_PACKAGING_CHAQUOPY_FIXTURE: chaquopyFixtureFile,
    GITHUB_OUTPUT: outputFile,
    ...extraEnv,
  }
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  try {
    const result = await execFileAsync(process.execPath, [script, root], { env, encoding: 'utf8' })
    return { code: 0, stdout: result.stdout, stderr: result.stderr, outputs: await readOutputs(outputFile) }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      outputs: await readOutputs(outputFile),
    }
  }
}

describe('android packaging resolver: pure pipeline projects', () => {
  it('resolves the stable channel latest release and skips prereleases', async () => {
    const { code, stdout, outputs } = await runResolver(await writeProject('pure-stable', {}))

    expect(code, stdout).toBe(0)
    expect(outputs.maafw_tag).toBe('v5.14.2')
    expect(outputs).toMatchObject({
      core_tag: '',
      has_agent: 'false',
      has_ocr: 'false',
      chaquopy_index: '',
      chaquopy_pins: '',
    })
  })

  it('resolves the beta channel to the newest release including prereleases', async () => {
    const { code, stdout, outputs } = await runResolver(await writeProject('pure-beta', { channel: 'beta' }))

    expect(code, stdout).toBe(0)
    expect(outputs.maafw_tag).toBe('v5.15.0-beta.1')
  })

  it('honours an exact maafw.version without consulting the channel', async () => {
    const { code, stdout, outputs } = await runResolver(await writeProject('pure-pinned', { maafwVersion: '5.12.3' }))

    expect(code, stdout).toBe(0)
    expect(outputs.maafw_tag).toBe('v5.12.3')
  })

  it('maps a pep 440 beta pin to the release tag the assets are published under', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('pure-pinned-beta', { maafwVersion: '5.15.0b1' }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.maafw_tag).toBe('v5.15.0-beta.1')
  })

  it('ignores AGENT_CORE_TAG because there is no agent runtime to pin', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('pure-override', { maafwVersion: '5.13.0' }),
      { AGENT_CORE_TAG: '3.13.15-maafw5.13.0' },
    )

    expect(code, stdout).toBe(0)
    expect(outputs.core_tag).toBe('')
  })
})

describe('android packaging resolver: python agent projects', () => {
  it('pairs the newest core for the requirements pin and emits chaquopy parameters', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('agent-pin', {
        agent: true,
        requirements: 'maafw==5.12.3\npillow==12.3.0\nloguru\n',
      }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs).toMatchObject({
      maafw_tag: 'v5.12.3',
      core_tag: '3.13.15-maafw5.12.3',
      has_agent: 'true',
      chaquopy_index: CHAQUOPY_INDEX_3_13,
      chaquopy_pins: '--exclude pillow --require pillow==11.0.0',
    })
  })

  it('pairs a beta pin spelled the pep 440 way with the prerelease kernel tag', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('agent-beta-normalized', { agent: true, requirements: 'maafw==5.15.0b1\n' }),
    )

    expect(code, stdout).toBe(0)
    expect(stdout).not.toContain('::warning::')
    expect(outputs).toMatchObject({
      // 内核 tag 与 release tag 用发布原文，requirements 用 uv 导出的归一形式：同一个版本
      maafw_tag: 'v5.15.0-beta.1',
      core_tag: '3.13.15-maafw5.15.0-beta.1',
    })
  })

  it('accepts the release spelling of the same beta pin', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('agent-beta-release', { agent: true, requirements: 'maafw==5.15.0-beta.1\n' }),
    )

    expect(code, stdout).toBe(0)
    expect(stdout).not.toContain('::warning::')
    expect(outputs.maafw_tag).toBe('v5.15.0-beta.1')
    expect(outputs.core_tag).toBe('3.13.15-maafw5.15.0-beta.1')
  })

  it('does not warn when the two files spell the same beta differently', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('agent-beta-spelling', {
        agent: true,
        maafwVersion: '5.15.0-beta.1',
        requirements: 'maafw==5.15.0b1\n',
      }),
    )

    expect(code, stdout).toBe(0)
    expect(stdout).not.toContain('::warning::')
    expect(outputs.core_tag).toBe('3.13.15-maafw5.15.0-beta.1')
  })

  it('pins the beta core through AGENT_CORE_TAG without a spelling warning', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('agent-beta-override', { agent: true, requirements: 'maafw==5.15.0b1\n' }),
      { AGENT_CORE_TAG: '3.13.15-maafw5.15.0-beta.1' },
    )

    expect(code, stdout).toBe(0)
    expect(stdout).not.toContain('::warning::')
    expect(outputs.core_tag).toBe('3.13.15-maafw5.15.0-beta.1')
  })

  it('warns when maa-project.json disagrees with the requirements pin and keeps the pin', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('agent-drift', {
        agent: true,
        maafwVersion: '5.13.0',
        requirements: 'maafw==5.12.3\n',
      }),
    )

    expect(code, stdout).toBe(0)
    expect(stdout).toContain('::warning::')
    expect(stdout).toContain('以 requirements 为准')
    expect(outputs.maafw_tag).toBe('v5.12.3')
  })

  it('falls back to the exact maafw.version when requirements has no pin', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('agent-fallback', { agent: true, maafwVersion: '5.13.0' }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.maafw_tag).toBe('v5.13.0')
    expect(outputs.core_tag).toBe('3.13.15-maafw5.13.0')
  })

  it('errors with guidance when neither source provides an exact version', async () => {
    const { code, stdout } = await runResolver(await writeProject('agent-channel-only', { agent: true }))

    expect(code).toBe(1)
    expect(stdout).toContain('::error::')
    expect(stdout).toContain('maafw==')
    expect(stdout).toContain('maafw.version')
  })

  it('degrades to the highest pairing at most the pin when the exact core is missing', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('agent-degrade', { agent: true, requirements: 'maafw==5.14.2\n' }),
    )

    expect(code, stdout).toBe(0)
    expect(stdout).toContain('::warning::')
    expect(stdout).toContain('降级到最高可用配对')
    expect(outputs.core_tag).toBe('3.13.15-maafw5.13.0')
    expect(outputs.maafw_tag).toBe('v5.13.0')
  })

  it('errors listing pairings when the pin is older than every kernel release', async () => {
    const { code, stdout } = await runResolver(
      await writeProject('agent-too-old', { agent: true, requirements: 'maafw==4.10.0\n' }),
    )

    expect(code).toBe(1)
    expect(stdout).toContain('::error::')
    expect(stdout).toContain('没有不高于 maafw4.10.0')
    expect(stdout).toContain('5.13.0、5.12.3、4.11.0')
    expect(stdout).toContain('AGENT_CORE_TAG')
  })

  it('pins the core via AGENT_CORE_TAG without warnings when the pairing matches', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('agent-override-ok', { agent: true, requirements: 'maafw==5.12.3\n' }),
      { AGENT_CORE_TAG: '3.13.99-maafw5.12.3' },
    )

    expect(code, stdout).toBe(0)
    expect(stdout).not.toContain('::warning::')
    expect(outputs.core_tag).toBe('3.13.99-maafw5.12.3')
  })

  it('follows a drifting AGENT_CORE_TAG with a warning', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('agent-override-drift', { agent: true, requirements: 'maafw==5.12.3\n' }),
      { AGENT_CORE_TAG: '3.13.15-maafw5.13.0' },
    )

    expect(code, stdout).toBe(0)
    expect(stdout).toContain('::warning::')
    expect(stdout).toContain('应急通道')
    expect(outputs.core_tag).toBe('3.13.15-maafw5.13.0')
    expect(outputs.maafw_tag).toBe('v5.13.0')
  })

  it('rejects AGENT_CORE_TAG values without a -maafw segment', async () => {
    const { code, stdout } = await runResolver(
      await writeProject('agent-override-bad', { agent: true, requirements: 'maafw==5.12.3\n' }),
      { AGENT_CORE_TAG: '3.13.99' },
    )

    expect(code).toBe(1)
    expect(stdout).toContain('解析不到 -maafw')
  })
})

describe('android packaging resolver: chaquopy tables', () => {
  it('errors listing known keys when the core CPython has no index entry', async () => {
    const { code, stdout } = await runResolver(
      await writeProject('chaquopy-unknown', { agent: true, requirements: 'maafw==5.12.3\n' }),
      { AGENT_CORE_TAG: '3.12.9-maafw5.12.3' },
    )

    expect(code).toBe(1)
    expect(stdout).toContain('CPython 3.12')
    expect(stdout).toContain('3.13')
  })

  it('emits no pins when requirements carries no table packages', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('chaquopy-clean', { agent: true, requirements: 'maafw==5.12.3\nloguru\n' }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.chaquopy_pins).toBe('')
  })

  it('matches requirement names in uv export format regardless of case and extras', async () => {
    const requirements = [
      'maafw==5.12.3 \\',
      '    --hash=sha256:deadbeef',
      'Pillow[speed]==12.3.0 \\',
      '    --hash=sha256:beefdead',
      'loguru',
      '',
    ].join('\n')
    const { code, stdout, outputs } = await runResolver(
      await writeProject('chaquopy-uv-export', { agent: true, requirements }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.maafw_tag).toBe('v5.12.3')
    expect(outputs.chaquopy_pins).toBe('--exclude pillow --require pillow==11.0.0')
  })

  it('leaves a package unpinned when the desktop pin is already on the index', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('chaquopy-exact', { agent: true, requirements: 'maafw==5.12.3\npillow==11.0.0\n' }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.chaquopy_pins).toBe('')
  })

  it('does not probe packages the kernel already provides', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('chaquopy-core-provides', {
        agent: true,
        requirements: 'maafw==5.12.3\nnumpy==2.2.0\n',
      }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.chaquopy_pins).toBe('')
  })

  it('skips environment-marker lines so a win32 pin is not installed on Android', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('chaquopy-marker', {
        agent: true,
        requirements: 'maafw==5.12.3\npillow==12.3.0 ; sys_platform == "win32"\n',
      }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.chaquopy_pins).toBe('')
  })

  it('errors when the index has builds but none for the kernel CPython', async () => {
    const { code, stdout } = await runResolver(
      await writeProject('chaquopy-wrong-cp', {
        agent: true,
        requirements: 'maafw==5.12.3\nopencv-python==4.10.0\n',
      }),
    )

    expect(code).toBe(1)
    expect(stdout).toContain('没有 cp313 兼容的')
    expect(stdout).toContain('opencv-python')
  })

  it('reads index filenames whose distribution is capitalised', async () => {
    // PEP 503 names are case-insensitive and the index still carries `Pillow-…` spellings, so a
    // case-sensitive prefix match would report "no build for this CPython" for such a package.
    const { code, stdout, outputs } = await runResolver(
      await writeProject('chaquopy-capitalised', {
        agent: true,
        requirements: 'maafw==5.12.3\ncryptography==41.0.0\n',
      }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.chaquopy_pins).toBe('--exclude cryptography --require cryptography==42.0.0')
  })
})

describe('android packaging resolver: artifact prefix', () => {
  it('passes an ASCII displayName through untouched', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('prefix-ascii', { displayName: 'M9A', slug: 'm9a', maafwVersion: '5.13.0' }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.artifact_prefix).toBe('M9A')
  })

  it('falls back to the slug for whitespace display names', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('prefix-space', { displayName: 'My Project', slug: 'my-project' }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.artifact_prefix).toBe('my-project')
  })

  it('falls back to the slug for non-ASCII display names', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('prefix-unicode', { displayName: '我的项目', slug: 'my-pi' }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.artifact_prefix).toBe('my-pi')
  })

  it('errors when neither displayName nor slug passes the ASCII gate', async () => {
    const { code, stdout } = await runResolver(await writeProject('prefix-invalid', { displayName: '', slug: '我的' }))

    expect(code).toBe(1)
    expect(stdout).toContain('project.displayName / project.slug')
  })
})

describe('android packaging resolver: ocr flag', () => {
  it('reports has_ocr when the project declares an ocr section', async () => {
    const { code, stdout, outputs } = await runResolver(
      await writeProject('ocr-present', { ocr: true, maafwVersion: '5.13.0' }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.has_ocr).toBe('true')
  })
})

describe('android packaging resolver: alignment with the desktop artifact name', () => {
  it.each(['M9A', 'MaaCommonAssets', 'proj_2.v2'])(
    'resolves the same prefix as releaseArtifactName for ASCII name %s',
    async (displayName) => {
      const { code, stdout, outputs } = await runResolver(
        await writeProject(`align-${displayName}`, { displayName, slug: 'fallback-slug' }),
      )

      expect(code, stdout).toBe(0)
      expect(outputs.artifact_prefix).toBe(releaseArtifactName({ displayName, slug: 'fallback-slug' }))
    },
  )

  it('diverges from the desktop name for whitespace display names (documented split)', async () => {
    const displayName = 'My Project'
    const slug = 'my-project'
    const { code, stdout, outputs } = await runResolver(
      await writeProject('align-diverge-space', { displayName, slug }),
    )

    expect(code, stdout).toBe(0)
    expect(outputs.artifact_prefix).toBe(slug)
    expect(releaseArtifactName({ displayName, slug })).toBe('My-Project')
  })
})
