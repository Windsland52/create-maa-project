import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCommand } from '../src/command.js'

const tempRoots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cmp-command-'))
  tempRoots.push(root)
  const cwd = join(root, 'project with spaces')
  await mkdir(cwd)
  const script = join(cwd, 'record args.mjs')
  const output = join(cwd, 'argv.json')
  await writeFile(
    script,
    'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n',
  )
  return { cwd, script, output }
}

describe('project command execution', () => {
  it('preserves absolute paths, spaces, and literal shell characters as arguments', async () => {
    const { cwd, script, output } = await fixture()
    vi.stubEnv('CMP_COMMAND_LITERAL', 'must not expand')
    const args = [
      join(cwd, 'node_modules/.pnpm'),
      'models & images',
      'model (small)',
      'test!data',
      '%CMP_COMMAND_LITERAL%',
      '',
    ]

    await runCommand(cwd, process.execPath, [script, output, ...args])

    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(args)
  })

  it.skipIf(process.platform !== 'win32')('runs command shims from directories with spaces', async () => {
    const { cwd, script, output } = await fixture()
    const shim = join(cwd, 'record args.cmd')
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
    const store = join(cwd, 'node_modules/.pnpm')

    await runCommand(cwd, shim, [output, '--virtual-store-dir', store])

    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(['--virtual-store-dir', store])
  })

  it('reports a failing child command instead of treating it as successful', async () => {
    const { cwd, script } = await fixture()
    await writeFile(script, 'process.exit(7)\n')

    await expect(runCommand(cwd, process.execPath, [script])).rejects.toThrow('exit code 7')
  })
})
