import { check } from 'prettier'
import { describe, expect, it } from 'vitest'
import { releaseWorkflowFile } from '../src/templates.js'

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
