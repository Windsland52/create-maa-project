import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import packageJson from '../package.json' with { type: 'json' }

const execFileAsync = promisify(execFile)
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const smokeScript = join(repoRoot, 'scripts/smoke-cli-artifact.mjs')
const cliEntry = join(repoRoot, 'dist/index.js')
const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('release artifact smoke verifier', () => {
  it('accepts an executable that reports the package version', async () => {
    const result = await execFileAsync(process.execPath, [smokeScript, process.execPath, cliEntry])

    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`${packageJson.version}\nVerified CLI artifact version ${packageJson.version}.\n`)
  })

  it('rejects an executable that reports a different version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-release-smoke-'))
    tempRoots.push(root)
    const wrongVersionCli = join(root, 'wrong-version.mjs')
    await writeFile(wrongVersionCli, 'console.log("9.9.9")\n', 'utf8')

    await expect(
      execFileAsync(process.execPath, [smokeScript, process.execPath, wrongVersionCli]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `CLI artifact version mismatch: expected ${packageJson.version}, received 9.9.9.`,
      ),
    })
  })

  it.skipIf(process.platform !== 'win32')('runs Windows command shims through the system shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cmp-release-smoke-'))
    tempRoots.push(root)
    const commandShim = join(root, 'create-maa-project.cmd')
    await writeFile(commandShim, `@echo off\r\n"${process.execPath}" "${cliEntry}" %*\r\n`, 'utf8')

    const result = await execFileAsync(process.execPath, [smokeScript, commandShim])

    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(`Verified CLI artifact version ${packageJson.version}.`)
  })
})
