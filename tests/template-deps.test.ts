import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { minimumNodeVersion, planPin } from '../scripts/sync-template-deps.js'
import { TEMPLATE_DEV_DEPENDENCIES, TEMPLATE_PNPM_VERSION } from '../src/template-deps.js'
import { devToolFiles, type ProjectTemplateInput } from '../src/templates.js'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** The formatter toolchain both this repository and a generated project depend on. */
const SHARED_TOOLCHAIN = [
  '@nekosu/prettier-plugin-maafw-sort',
  'prettier',
  'prettier-plugin-multiline-arrays',
]

const DEV_TOOL_INPUT: ProjectTemplateInput = {
  slug: 'maa-example',
  displayName: 'Maa Example',
  version: '0.1.0',
  controllers: [
    'Adb',
  ],
  license: 'AGPL-3.0-or-later',
  includeDevTools: true,
  includeVscode: false,
  includeGithub: false,
  includeAgent: false,
  includeGitCliff: false,
  includeAutoFormat: false,
  includeOptimizeImages: false,
  includeSchemaSync: false,
}

function generatedPackageJson(): Record<string, unknown> {
  const file = devToolFiles(DEV_TOOL_INPUT).find((entry) => entry.path === 'package.json')
  const content = String(file?.content ?? '')
  // A leftover placeholder would make this parse fail, which is the point.
  expect(content).not.toContain('{{')
  return JSON.parse(content) as Record<string, unknown>
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
  })
  return entries.filter((entry) => entry.endsWith('.md')).sort()
}

describe('generated dependency pins', () => {
  it('renders every pinned dependency from the single source', () => {
    const packageJson = generatedPackageJson()

    expect(packageJson.devDependencies).toEqual(TEMPLATE_DEV_DEPENDENCIES)
    expect(packageJson.packageManager).toBe(`pnpm@${TEMPLATE_PNPM_VERSION}`)
  })

  it('pins exact versions instead of ranges', () => {
    for (const [
      name,
      version,
    ] of Object.entries(TEMPLATE_DEV_DEPENDENCIES)) {
      expect(version, `${name} must be pinned exactly`).toMatch(/^\d+\.\d+\.\d+$/)
    }
    expect(TEMPLATE_PNPM_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('keeps version literals out of the template', async () => {
    // Regression guard: every pin used to be written literally here, so bumping one meant editing
    // the template, this repository's own package.json and this test suite by hand.
    const template = await readFile(join(repoRoot, 'templates/addons/dev-tools/package.json'), 'utf8')

    expect(template).toContain('"devDependencies": {{devDependencies}}')
    expect(template).toContain('"packageManager": "pnpm@{{pnpmVersion}}"')
    // Also catches a range such as "^1.2.3", which would pin freshness to the installer instead.
    expect(template).not.toMatch(/"[~^>=<]*\d+\.\d+\.\d+"/)
  })

  it('keeps the pnpm patch version out of the shipped documents', async () => {
    // Same-major automation moves that pin, so a document spelling it out goes stale on its own.
    // CHANGELOG.md is deliberately excluded: it is history, not documentation.
    const documents = [
      'AGENTS.md',
      'README.en.md',
      'README.md',
      'RELEASING.md',
      ...(await markdownFiles(join(repoRoot, 'docs'))).map((file) => join('docs', file)),
      ...(await markdownFiles(join(repoRoot, 'skills'))).map((file) => join('skills', file)),
    ]
    expect(documents.length).toBeGreaterThan(5)

    for (const document of documents) {
      const content = await readFile(join(repoRoot, document), 'utf8')
      expect(content, `${document} states the pnpm patch version`).not.toMatch(/pnpm[ @]v?\d+\.\d+\.\d+/)
    }
  })

  it('keeps this repository on the same toolchain as generated projects', async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      packageManager?: string
      devDependencies?: Record<string, string>
    }

    expect(packageJson.packageManager).toBe(`pnpm@${TEMPLATE_PNPM_VERSION}`)
    // The CLI formats its own templates with these packages, so drift here can make format:check
    // fail inside a freshly generated project.
    for (const name of SHARED_TOOLCHAIN) {
      const pinned = TEMPLATE_DEV_DEPENDENCIES[name]
      expect(pinned, `${name} must stay pinned for generated projects`).toBeDefined()
      expect(packageJson.devDependencies?.[name], `${name} must match the generated pin`).toBe(pinned)
    }
    // Any other package this repository happens to share with generated projects must agree too.
    for (const [
      name,
      version,
    ] of Object.entries(TEMPLATE_DEV_DEPENDENCIES)) {
      const repoVersion = packageJson.devDependencies?.[name]
      if (repoVersion === undefined) continue
      expect(repoVersion, `${name} must match the generated pin`).toBe(version)
    }
  })
})

describe('dependency sync policy', () => {
  it('moves a pin inside its current major', () => {
    expect(planPin({ name: 'prettier', current: '1.2.3', latest: '1.2.4', allowMajor: false })).toMatchObject({
      action: 'update',
    })
  })

  it('holds a major bump until --major is passed', () => {
    expect(planPin({ name: 'prettier', current: '1.2.3', latest: '2.0.0', allowMajor: false })).toMatchObject({
      action: 'hold-major',
    })
    expect(planPin({ name: 'prettier', current: '1.2.3', latest: '2.0.0', allowMajor: true })).toMatchObject({
      action: 'update',
    })
  })

  it('leaves a pin alone when the registry has nothing newer', () => {
    expect(planPin({ name: 'prettier', current: '1.2.3', latest: '1.2.3', allowMajor: false })).toMatchObject({
      action: 'current',
    })
  })

  it('holds a pnpm bump that would outgrow the declared Node floor', () => {
    // A pnpm that needs a newer Node than src/node-support.ts declares would break every generated
    // project's install, so the automation stops instead of committing it.
    expect(
      planPin({
        name: 'pnpm',
        current: '1.2.3',
        latest: '1.2.4',
        allowMajor: false,
        manifest: {
          engines: {
            node: '>=23.0.0',
          },
        },
      }),
    ).toMatchObject({
      action: 'hold-major',
    })
    expect(
      planPin({
        name: 'pnpm',
        current: '1.2.3',
        latest: '1.2.4',
        allowMajor: false,
        manifest: {
          engines: {
            node: '>=22.13.0 <23',
          },
        },
      }),
    ).toMatchObject({
      action: 'update',
    })
  })

  it('reads the lowest concrete Node version out of an engines range', () => {
    expect(minimumNodeVersion('>=22.13.0 <23')).toBe('22.13.0')
    expect(minimumNodeVersion('<23 >=22.13.0')).toBe('22.13.0')
    expect(minimumNodeVersion('20.0.0 - 22.13.0')).toBe('20.0.0')
    expect(minimumNodeVersion('^22.13')).toBe('22.13.0')
    expect(minimumNodeVersion('>=22')).toBe('22.0.0')
    // Prerelease identifiers must not be read as versions of their own.
    expect(minimumNodeVersion('>=22.13.0-rc.1 <23')).toBe('22.13.0')
    expect(minimumNodeVersion('>=22.13.0-0')).toBe('22.13.0')
    expect(minimumNodeVersion('>=18.*')).toBe('18.0.0')
    expect(minimumNodeVersion(undefined)).toBeUndefined()
  })
})
