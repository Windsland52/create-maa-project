import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { createCycloneDxBom } from '../scripts/create-sbom.mjs'

describe('CycloneDX release SBOM', () => {
  it('records stable production dependency components and relationships', () => {
    const bom = createCycloneDxBom(
      { name: 'create-maa-project', version: '1.2.3', license: 'AGPL-3.0-or-later' },
      {
        dependencies: {
          '@scope/sdk': {
            version: '2.0.0',
            dependencies: { zod: { version: '4.0.0' } },
          },
        },
      },
      {
        MIT: [{ name: '@scope/sdk', versions: ['2.0.0'], license: 'MIT' }],
        'MIT OR Zlib': [{ name: 'zod', versions: ['4.0.0'], license: 'MIT OR Zlib' }],
      },
    )

    expect(bom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1 })
    expect(bom.metadata.component).toMatchObject({
      type: 'application',
      name: 'create-maa-project',
      version: '1.2.3',
      purl: 'pkg:npm/create-maa-project@1.2.3',
    })
    expect(bom.components).toEqual([
      expect.objectContaining({
        group: '@scope',
        name: 'sdk',
        version: '2.0.0',
        purl: 'pkg:npm/%40scope/sdk@2.0.0',
        licenses: [{ license: { id: 'MIT' } }],
      }),
      expect.objectContaining({
        name: 'zod',
        version: '4.0.0',
        licenses: [{ license: { name: 'MIT OR Zlib' } }],
      }),
    ])
    expect(bom.dependencies).toEqual([
      { ref: 'pkg:npm/create-maa-project@1.2.3', dependsOn: ['pkg:npm/%40scope/sdk@2.0.0'] },
      { ref: 'pkg:npm/%40scope/sdk@2.0.0', dependsOn: ['pkg:npm/zod@4.0.0'] },
      { ref: 'pkg:npm/zod@4.0.0', dependsOn: [] },
    ])
  })

  it('publishes the generated SBOM with GitHub releases', async () => {
    const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
    expect(workflow).toContain('pnpm release:sbom')
    expect(workflow).toMatch(/name: sbom\s+path: dist\/release\/create-maa-project\.cdx\.json/)
    expect(workflow).toMatch(/name: sbom\s+path: dist\/release/)
  })
})
