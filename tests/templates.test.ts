import { check } from 'prettier'
import { describe, expect, it } from 'vitest'
import {
  devToolFiles,
  githubFiles,
  releaseWorkflowFile,
  vscodeFiles,
  type ProjectTemplateInput,
} from '../src/templates.js'

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
    false,
    true,
  ])('emits formatted release workflow with git-cliff=%s', async (includeGitCliff) => {
    const file = releaseWorkflowFile({
      slug: 'maaxxxx',
      displayName: 'MaaXXXX',
      includeGitCliff,
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
  })
})
