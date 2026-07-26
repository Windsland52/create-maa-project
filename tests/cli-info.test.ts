import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }

const execFileAsync = promisify(execFile)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliEntry = join(repoRoot, 'dist/index.js')
const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('CLI help and version', () => {
  it.each([
    '--help',
    '-h',
  ])('prints help for %s without creating local project state', async (option) => {
    const root = await tempRoot()
    const result = await execFileAsync(
      process.execPath,
      [
        cliEntry,
        option,
      ],
      { cwd: root },
    )

    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(`create-maa-project ${packageJson.version}`)
    expect(result.stdout).toContain('Usage:')
    expect(result.stdout).toContain('Maintenance modes:')
    expect(result.stdout).toContain('Examples:')
    expect(await readdir(root)).toEqual([])
  })

  it.each([
    '--cli-version',
    '-V',
  ])('prints only the package version for %s without creating local project state', async (option) => {
    const root = await tempRoot()
    const result = await execFileAsync(
      process.execPath,
      [
        cliEntry,
        option,
      ],
      { cwd: root },
    )

    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`${packageJson.version}\n`)
    expect(await readdir(root)).toEqual([])
  })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cmp-cli-info-'))
  tempRoots.push(root)
  return root
}
