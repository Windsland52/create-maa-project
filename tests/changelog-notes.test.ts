import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const script = join(repoRoot, 'scripts', 'changelog-notes.mjs')

type Run = { code: number; stdout: string; stderr: string }

async function runNotes(version?: string): Promise<Run> {
  try {
    const args = version === undefined ? [script] : [script, version]
    const result = await execFileAsync(process.execPath, args, { encoding: 'utf8' })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

/** Every version heading the changelog declares. */
async function declaredVersions(): Promise<string[]> {
  const content = await readFile(join(repoRoot, 'CHANGELOG.md'), 'utf8')
  return [...content.matchAll(/^## \[v?([^\]]+)\]/gm)].map((match) => match[1] as string)
}

const versions = await declaredVersions()

describe('release notes extraction', () => {
  it('covers every version declared in the changelog', () => {
    // Guard against the matcher silently finding nothing and `it.each` passing vacuously.
    expect(versions.length).toBeGreaterThan(5)
    expect(versions).toContain('3.3.0')
  })

  it('extracts the section for the upcoming release, including its migration text', async () => {
    const result = await runNotes('v3.3.0')

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('## [3.3.0]')
    expect(result.stdout).toContain('### 不兼容变更')
    // The migration steps are the point of the section, so they must survive extraction.
    expect(result.stdout).toContain('`--add dev-tools` 不再写入 `.vscode/`')
    expect(result.stdout).toContain('CREATE_MAA_PROJECT_OCR_SOURCE=download')
  })

  it('accepts a bare version and a v-prefixed one', async () => {
    const [bare, prefixed] = await Promise.all([runNotes('3.3.0'), runNotes('v3.3.0')])

    expect(bare.code, bare.stderr).toBe(0)
    expect(bare.stdout).toBe(prefixed.stdout)
  })

  it.each(versions)('extracts %s without leaking a trailing link definition', async (version) => {
    const result = await runNotes(version)

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim().length).toBeGreaterThan(0)
    // Compare-URL definitions belong to the file, not to the release body. The last section has no
    // following heading, which is the shape that regressed before.
    expect(result.stdout).not.toMatch(/^\[[^\]]+\]:\s+\S+$/m)
  })

  it('fails when the tag has no section, so an empty release body cannot ship', async () => {
    const result = await runNotes('v9.9.9')

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('No CHANGELOG.md section found for v9.9.9')
    expect(result.stdout).toBe('')
  })

  it('fails with usage when no version is given', async () => {
    const result = await runNotes()

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('Usage: node scripts/changelog-notes.mjs <version>')
  })
})
