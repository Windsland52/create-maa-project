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
    expect(content).toContain('sha512sum --check "$checksum"')
    expect(content).toContain("--exclude '*-*' HEAD^")
    expect(content).toContain('"$previous_stable_tag..HEAD"')
    expect(content).not.toContain('--latest')
  })
})
