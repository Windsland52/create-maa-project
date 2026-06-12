import { check } from 'prettier'
import { describe, expect, it } from 'vitest'
import { releaseWorkflowFile } from '../src/templates.js'

describe('workflow templates', () => {
  it.each([
    false,
    true
  ])('emits formatted release workflow with git-cliff=%s', async (includeGitCliff) => {
    const file = releaseWorkflowFile({ slug: 'maaxxxx', includeGitCliff })
    expect(typeof file.content).toBe('string')
    await expect(
      check(file.content.toString(), {
        parser: 'yaml',
        singleQuote: true,
        trailingComma: 'none',
        tabWidth: 2,
        printWidth: 100
      })
    ).resolves.toBe(true)
  })
})
