import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pinsSupportedNode, SUPPORTED_NODE_MAJOR, SUPPORTED_NODE_RANGE } from '../src/node-support.js'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

describe('supported Node floor', () => {
  it('declares a floor that satisfies the pinned pnpm major', () => {
    // pnpm 11 requires Node >=22.13 (it uses the node:sqlite builtin). If the pin ever moves to a
    // pnpm major that needs more, this floor must move with it.
    expect(SUPPORTED_NODE_MAJOR).toBe('22')
    expect(SUPPORTED_NODE_RANGE).toBe('>=22.13')
  })

  it('accepts the pinned line and rejects anything below the floor', () => {
    for (const value of [
      '22',
      'v22',
      '22.13',
      '22.13.0',
      '22.14',
      '22.20.2',
      '22\n',
    ]) {
      expect(pinsSupportedNode(value), value).toBe(true)
    }
    for (const value of [
      '20',
      '20.20.2',
      '21',
      '23',
      '24',
      // Below the floor: this resolves to a Node that cannot run the pinned pnpm.
      '22.0',
      '22.1',
      '22.12',
      '22.12.9',
      '',
      'latest',
    ]) {
      expect(pinsSupportedNode(value), value).toBe(false)
    }
  })

  it('keeps the generated manifest and this package on the same floor', async () => {
    const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      engines: { node: string }
    }
    const templatePackage = await readFile(join(repoRoot, 'templates/addons/dev-tools/package.json'), 'utf8')

    expect(packageJson.engines.node).toBe(SUPPORTED_NODE_RANGE)
    // The template carries a placeholder so the two cannot drift apart.
    expect(templatePackage).toContain('"node": "{{nodeRange}}"')
  })

  it('leaves no hardcoded Node 24 in the generated output', async () => {
    // Regression guard: the floor used to be written literally in five workflow templates, the
    // dev-tools manifest and four doctor messages, so lowering it was easy to do halfway.
    const files = [
      'templates/addons/auto-format/.github/workflows/format.yml',
      'templates/addons/github/.github/workflows/check.yml',
      'templates/addons/github/.github/workflows/release.yml',
      'templates/addons/optimize-images/.github/workflows/optimize-images.yml',
      'templates/addons/schema-sync/.github/workflows/schema-sync.yml',
      'templates/addons/dev-tools/package.json',
      'src/doctor.ts',
      'src/templates.ts',
    ]

    for (const file of files) {
      const content = await readFile(join(repoRoot, file), 'utf8')
      expect(content, `${file} still pins Node 24`).not.toMatch(/node-version:\s*['"]?24\b/)
      expect(content, `${file} still requires Node 24`).not.toMatch(/"node":\s*">=24"/)
      expect(content, `${file} still mentions Node 24`).not.toMatch(/Node 24/)
    }
  })
})
