import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('release workflow publication ordering', () => {
  it('gates registry publication and makes retries idempotent', async () => {
    const workflow = (await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')).replace(
      /\r\n/g,
      '\n',
    )

    expect(workflow).toMatch(/\n  npm:\n    needs: github-release\n/)
    expect(workflow).toMatch(/\n  pypi:\n    needs: npm\n/)
    expect(workflow).toContain('npm view "$package_name@$package_version" version')
    expect(workflow).toContain('is already published; skipping npm publish.')
    expect(workflow).toContain('skip-existing: true')
    expect(workflow).toContain('pnpm audit --audit-level high')
  })
})
