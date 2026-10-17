import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { check } from 'prettier'
import { describe, expect, it } from 'vitest'
import { PYTHON_EMBED_VERSION, PYTHON_STANDALONE_MINOR } from '../src/assets.js'
import { androidAppId, isValidAndroidAppId } from '../src/android.js'
import { SUPPORTED_NODE_MAJOR } from '../src/node-support.js'
import {
  agentFiles,
  androidFiles,
  devToolFiles,
  githubFiles,
  releaseWorkflowFile,
  vscodeFiles,
  withAndroidRuffExclude,
  type ProjectTemplateInput,
} from '../src/templates.js'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The file lists are documented for users in docs/commands.md and the skill reference. Changing
 * a set here means those documents need the same update, so this test fails deliberately.
 */
const DEV_TOOL_FILES = [
  '.node-version',
  '.prettierignore',
  '.prettierrc.mjs',
  'package.json',
  'pnpm-workspace.yaml',
  'tools/schema/custom.action.schema.json',
  'tools/schema/custom.recognition.schema.json',
  'tools/schema/interface.schema.json',
  'tools/schema/interface_config.schema.json',
  'tools/schema/interface_import.schema.json',
  'tools/schema/pipeline.schema.json',
  'tools/schema/schema-manifest.json',
  'tools/validate-schema.mjs',
]

const VSCODE_FILES = [
  '.vscode/extensions.json',
  '.vscode/settings.json',
  '.vscode/tasks.json',
]

function devToolInput(includeAgent: boolean): ProjectTemplateInput {
  return {
    slug: 'maa-example',
    displayName: 'Maa Example',
    version: '0.1.0',
    controllers: ['Adb'],
    license: 'AGPL-3.0-or-later',
    includeDevTools: true,
    includeVscode: true,
    includeGithub: false,
    includeAgent,
    includeGitCliff: false,
    includeAutoFormat: false,
    includeOptimizeImages: false,
    includeSchemaSync: false,
  }
}

describe('dev-tools templates', () => {
  it('writes exactly the documented file set for a pipeline project', () => {
    const paths = devToolFiles(devToolInput(false))
      .map((file) => file.path)
      .sort()

    expect(paths).toEqual(DEV_TOOL_FILES)
    // docs/commands.md states the count.
    expect(paths).toHaveLength(13)
  })

  it('keeps editor integration out of the dev-tools set', () => {
    // vscode is a separate add-on that requires dev-tools, so devToolFiles never writes .vscode.
    const paths = devToolFiles(devToolInput(true)).map((file) => file.path)

    expect(paths.some((path) => path.startsWith('.vscode/'))).toBe(false)
  })

  it('keeps project-owned files one-shot and refreshable files managed', () => {
    const files = devToolFiles(devToolInput(true))
    const byMode = (managed: boolean): string[] =>
      files
        .filter((file) => file.managed === managed)
        .map((file) => file.path)
        .sort()

    // `once` files belong to the project after creation; `managed` files may be refreshed
    // by --update. docs/commands.md documents both columns.
    expect(byMode(false)).toEqual([
      '.prettierignore',
      'package.json',
      'pnpm-workspace.yaml',
      'tools/schema/custom.action.schema.json',
      'tools/schema/custom.recognition.schema.json',
    ])
    expect(byMode(true)).toEqual([
      '.node-version',
      '.prettierrc.mjs',
      'tools/schema/interface.schema.json',
      'tools/schema/interface_config.schema.json',
      'tools/schema/interface_import.schema.json',
      'tools/schema/pipeline.schema.json',
      'tools/schema/schema-manifest.json',
      'tools/validate-schema.mjs',
    ])
  })
})

describe('vscode templates', () => {
  it('writes exactly the documented file set for a pipeline project', () => {
    const paths = vscodeFiles(devToolInput(false))
      .map((file) => file.path)
      .sort()

    expect(paths).toEqual(VSCODE_FILES)
    expect(paths).toHaveLength(3)
  })

  it('adds only the launch configuration for an agent project', () => {
    const paths = vscodeFiles(devToolInput(true))
      .map((file) => file.path)
      .sort()

    expect(paths).toEqual([...VSCODE_FILES, '.vscode/launch.json'].sort())
  })

  it('refreshes only the tasks file and keeps the rest project-owned', () => {
    const managed = vscodeFiles(devToolInput(true))
      .filter((file) => file.managed)
      .map((file) => file.path)

    expect(managed).toEqual(['.vscode/tasks.json'])
  })
})

describe('workflow templates', () => {
  it.each([
    [
      false,
      false,
    ],
    [
      true,
      false,
    ],
    [
      false,
      true,
    ],
    [
      true,
      true,
    ],
  ])('emits a formatted release workflow with git-cliff=%s and android=%s', async (includeGitCliff, includeAndroid) => {
    const file = releaseWorkflowFile({
      slug: 'maaxxxx',
      displayName: 'MaaXXXX',
      includeGitCliff,
      includeAndroid,
    })
    expect(typeof file.content).toBe('string')
    await expect(
      check(file.content.toString(), {
        parser: 'yaml',
        trailingComma: 'none',
        tabWidth: 2,
        printWidth: 100,
      }),
    ).resolves.toBe(true)
  })

  it('emits a formatted package-smoke workflow covering every release target', async () => {
    const file = githubFiles(devToolInput(true)).find((entry) => entry.path === '.github/workflows/package-smoke.yml')

    expect(file?.managed).toBe(true)
    const content = String(file?.content ?? '')
    // The placeholders must be fully rendered, and the matrix must mirror release.yml.
    expect(content.replaceAll('${{', '')).not.toContain('{{')
    expect(content.match(/- os: /g) ?? []).toHaveLength(6)
    for (const runner of [
      'windows-latest',
      'windows-11-arm',
      'ubuntu-latest',
      'ubuntu-24.04-arm',
      'macos-15-intel',
      'macos-latest',
    ]) {
      expect(content).toContain(`- os: ${runner}`)
    }
    await expect(
      check(content, {
        parser: 'yaml',
        trailingComma: 'none',
        tabWidth: 2,
        printWidth: 100,
      }),
    ).resolves.toBe(true)
  })

  it('leaves no MXU package expectation unguarded on linux-arm64', () => {
    const file = githubFiles(devToolInput(true)).find((entry) => entry.path === '.github/workflows/package-smoke.yml')
    const expectations = String(file?.content ?? '')
      .split('\n')
      .filter((line) => line.includes("'package-mxu'"))

    // MXU publishes no linux-arm64 runtime: tools/sync-runtime.mjs skips that target and
    // tools/build-release.mjs then produces no package-mxu. Both verification branches (Windows
    // and bash) must therefore guard the expectation, or package-smoke stays red on
    // ubuntu-24.04-arm for every project that enables MXU.
    expect(expectations).toHaveLength(2)
    for (const line of expectations) {
      expect(line).toContain('linux-arm64')
    }
  })

  it('pins and verifies git-cliff while generating cumulative release notes', () => {
    const file = releaseWorkflowFile({
      slug: 'maaxxxx',
      displayName: 'MaaXXXX',
      includeGitCliff: true,
    })
    const content = file.content.toString()

    expect(content).toContain('version="2.13.1"')
    expect(content).toContain(
      'expected_sha512="e716cce3a07dda41b1e370d6afbd7a59eb3d4739509fb7856aeec8da2be28c0396584e29e106141c1a1c535c1827dbc1f60417524f5cfb1da9e11f700bd00f30"',
    )
    expect(content).toContain('sha512sum --check --strict')
    expect(content).not.toContain('curl -fsSL "$download_url/$checksum"')
    expect(content).toContain("--exclude '*-*' HEAD^")
    expect(content).toContain('"$previous_stable_tag..HEAD"')
    expect(content).not.toContain('--latest')
    // Notes must not be what fails a release: the first run keeps pull request and contributor
    // data, and the offline retry still writes them when that data is unreachable.
    expect(content).toContain('--offline "$previous_stable_tag..HEAD"')
    expect(content).toContain('::warning::GitHub metadata is unavailable')
  })
})

describe('android templates', () => {
  const ANDROID_FILES = [
    '.github/workflows/android-build.yml',
    '.github/workflows/android.yml',
    'Android/README.md',
    'Android/profile.yaml',
    'tools/android-packaging.mjs',
  ]

  it('writes exactly the documented file set for a pipeline project', () => {
    const paths = androidFiles({ slug: 'maa-example', displayName: 'Maa Example', includeAgent: false })
      .map((file) => file.path)
      .sort()

    expect(paths).toEqual(ANDROID_FILES)
    expect(paths).toHaveLength(5)
  })

  it('keeps the recipe and its README project-owned and the tooling refreshable', () => {
    const files = androidFiles({ slug: 'maa-example', displayName: 'Maa Example', includeAgent: false })
    const byMode = (managed: boolean): string[] =>
      files
        .filter((file) => file.managed === managed)
        .map((file) => file.path)
        .sort()

    // The recipe is hand-maintained from the first build on; MaaFwApp owns its schema. The resolver
    // and the workflows follow the CLI so a probe rule or a toolchain pin can be shipped.
    expect(byMode(false)).toEqual([
      'Android/README.md',
      'Android/profile.yaml',
    ])
    expect(byMode(true)).toEqual([
      '.github/workflows/android-build.yml',
      '.github/workflows/android.yml',
      'tools/android-packaging.mjs',
    ])
  })

  it('renders the recipe variant the project shape needs', () => {
    const recipe = (includeAgent: boolean): string =>
      String(
        androidFiles({ slug: 'maa-example', displayName: 'Maa Example', includeAgent }).find(
          (file) => file.path === 'Android/profile.yaml',
        )?.content ?? '',
      )
    const pipeline = recipe(false)
    const agent = recipe(true)

    expect(pipeline).not.toContain('{{')
    expect(agent).not.toContain('{{')
    expect(pipeline).toMatch(/^assets: \.\.$/m)
    expect(pipeline).not.toMatch(/^agent:$/m)
    expect(agent).toMatch(/^agent:$/m)
    expect(agent).toContain('sourceDir: agent-dist')
    // A recipe that lists `include` replaces the built-in whitelist, so the payload must be there.
    expect(agent).toContain('  - agent/**')
    // The application id is a lowercase package segment appended to com.aliothmoon.maafw, so a
    // kebab-case project id cannot be copied verbatim.
    for (const recipe of [
      pipeline,
      agent,
    ]) {
      expect(recipe).toMatch(/^ {2}id: maa_example$/m)
      expect(recipe).toMatch(/^ {2}label: Maa Example$/m)
    }
  })

  it('derives an application id the shell accepts, whatever the project id looks like', () => {
    const recipeId = (slug: string): string =>
      String(
        androidFiles({ slug, displayName: 'x', includeAgent: false }).find(
          (file) => file.path === 'Android/profile.yaml',
        )?.content ?? '',
      )

    expect(androidAppId('m9a')).toBe('m9a')
    expect(androidAppId('maa-helper')).toBe('maa_helper')
    expect(androidAppId('maa--helper')).toBe('maa_helper')
    expect(androidAppId('9a')).toBe('p9a')
    for (const slug of [
      'm9a',
      'maa-helper',
      '9a',
      'proj.2',
    ]) {
      const appId = /^ {2}id: (\S+)$/m.exec(recipeId(slug))?.[1] ?? ''
      expect(isValidAndroidAppId(appId), `${slug} → ${appId}`).toBe(true)
    }
  })

  it('renders both workflows with no placeholder left behind', () => {
    const files = androidFiles({ slug: 'maa-example', displayName: 'Maa Example', includeAgent: false })
    for (const path of [
      '.github/workflows/android.yml',
      '.github/workflows/android-build.yml',
    ]) {
      const content = String(files.find((file) => file.path === path)?.content ?? '')
      // `${{ ... }}` is GitHub's own expression syntax and must survive rendering.
      expect(content.replaceAll('${{', ''), path).not.toContain('{{')
    }
    const entry = String(files.find((file) => file.path === '.github/workflows/android.yml')?.content ?? '')
    const build = String(files.find((file) => file.path === '.github/workflows/android-build.yml')?.content ?? '')
    expect(entry).toContain('- "Android/**"')
    expect(entry).toContain('uses: ./.github/workflows/android-build.yml')
    expect(build).toContain('Android/MaaFwApp')
    expect(build).toContain(`node-version: ${SUPPORTED_NODE_MAJOR}`)
    expect(build).toContain('run: node tools/android-packaging.mjs')
    expect(build).toContain('uv export --frozen')
    expect(build).toContain('GITHUB_REF_TYPE')
    expect(build).toContain('unzip -Z1')
  })

  it('renders every android file without a leftover placeholder', () => {
    for (const includeAgent of [
      false,
      true,
    ]) {
      for (const file of androidFiles({ slug: 'maa-example', displayName: 'Maa Example', includeAgent })) {
        if (Buffer.isBuffer(file.content)) continue
        expect(file.content.replaceAll('${{', ''), file.path).not.toContain('{{')
      }
    }
  })

  it('emits workflows and recipes a YAML parser accepts', async () => {
    for (const includeAgent of [
      false,
      true,
    ]) {
      for (const file of androidFiles({ slug: 'maa-example', displayName: 'Maa Example', includeAgent })) {
        if (!file.path.endsWith('.yml') && !file.path.endsWith('.yaml')) continue
        await expect(
          check(String(file.content), {
            parser: 'yaml',
            trailingComma: 'none',
            tabWidth: 2,
            printWidth: 100,
          }),
          file.path,
        ).resolves.toBe(true)
      }
    }
  })
})

describe('agent pyproject ruff scope', () => {
  const pyproject = (includeAndroid: boolean): string =>
    String(
      agentFiles({
        slug: 'maa-example',
        version: '0.1.0',
        displayName: 'Maa Example',
        includeAndroid,
      }).find((file) => file.path === 'pyproject.toml')?.content ?? '',
    )

  it('excludes the vendored shell from ruff when the project has one', () => {
    const content = pyproject(true)

    expect(content).toContain('extend-exclude = ["Android/MaaFwApp"]')
    // `release.yml` checks out submodules, so an unscoped `ruff check .` reads the shell's own
    // scripts and fails on them (UP009). The line has to land inside [tool.ruff]: a stray line above
    // the header would silently become nobody's setting, and one below would become a pyright key.
    expect(content.indexOf('extend-exclude')).toBeGreaterThan(content.indexOf('[tool.ruff]'))
    expect(content.indexOf('extend-exclude')).toBeLessThan(content.indexOf('[tool.pyright]'))
  })

  it('keeps a project without the shell byte-identical', () => {
    const withoutShell = pyproject(false)

    expect(withoutShell).not.toContain('extend-exclude')
    expect(pyproject(true).replace(/^# Android\/MaaFwApp.*\n^extend-exclude.*\n/mu, '')).toBe(withoutShell)
  })

  it('inserts the same lines into a pyproject.toml the project already owns', () => {
    const current = pyproject(false)
    const patched = withAndroidRuffExclude(current)

    expect(patched).toContain('extend-exclude = ["Android/MaaFwApp"]')
    expect(patched.indexOf('extend-exclude')).toBeLessThan(patched.indexOf('[tool.pyright]'))
    // `--add android` and `--add agent` both run more than once on the same project.
    expect(withAndroidRuffExclude(patched)).toBe(patched)
    expect(withAndroidRuffExclude(current, false)).toBe(current)
    // A file without a [tool.ruff] table has nothing to extend, and inventing one would add settings
    // the project never asked for.
    expect(withAndroidRuffExclude('[project]\nname = "x"\n')).toBe('[project]\nname = "x"\n')
  })
})

describe('android packaging hook in the generated release workflow', () => {
  it('renders the release workflow unchanged when the add-on is off', () => {
    const content = releaseWorkflowFile({
      slug: 'maaxxxx',
      displayName: 'MaaXXXX',
      includeGitCliff: false,
      includeAndroid: false,
    }).content.toString()

    expect(content).toContain('needs: package')
    expect(content).not.toContain('needs: [package, android]')
    expect(content).not.toContain('*.apk')
    expect(content).not.toContain('android-build.yml')
  })

  it('waits for the android job and publishes the APKs when it is on', () => {
    const content = releaseWorkflowFile({
      slug: 'maaxxxx',
      displayName: 'MaaXXXX',
      includeGitCliff: false,
      includeAndroid: true,
    }).content.toString()

    expect(content).toContain('needs: [package, android]')
    expect(content).toContain('release-assets/*.apk')
    expect(content).toContain('uses: ./.github/workflows/android-build.yml')
    // Desktop packages and the APK build in parallel; only the release job waits for both.
    // The tag gate still matters: `release.yml` also runs on workflow_dispatch, where nothing
    // publishes an APK.
    expect(content).toMatch(
      /android:\n {4}name: Build Android APK\n {4}if: startsWith\(github\.ref, 'refs\/tags\/'\)\n {4}uses:/,
    )
    expect(content).not.toMatch(/android:\n {4}name: Build Android APK\n {4}if: .*\n {4}needs: package/)
  })

  it('lists android before git-cliff so the generated needs stays stable', () => {
    const content = releaseWorkflowFile({
      slug: 'maaxxxx',
      displayName: 'MaaXXXX',
      includeGitCliff: true,
      includeAndroid: true,
    }).content.toString()

    expect(content).toContain('needs: [package, android, git_cliff]')
  })
})

describe('generated release tooling', () => {
  it('renders the Python runtime versions from the CLI constants', async () => {
    const rendered = githubFiles(devToolInput(true)).find((entry) => entry.path === 'tools/sync-runtime.mjs')
    const content = String(rendered?.content ?? '')

    expect(content).toContain(`const PYTHON_EMBED_VERSION = "${PYTHON_EMBED_VERSION}";`)
    expect(content).toContain(`const PYTHON_STANDALONE_MINOR = "${PYTHON_STANDALONE_MINOR}";`)
    expect(content).not.toContain('{{')

    // The template itself must stay placeholder-driven: a copied literal would let the CLI's
    // `--update python-runtime` and this project-side script download different interpreters.
    const source = await readFile(join(repoRoot, 'templates/addons/github/tools/sync-runtime.mjs'), 'utf8')
    expect(source).toContain('const PYTHON_EMBED_VERSION = "{{pythonEmbedVersion}}";')
    expect(source).toContain('const PYTHON_STANDALONE_MINOR = "{{pythonStandaloneMinor}}";')
  })
})
