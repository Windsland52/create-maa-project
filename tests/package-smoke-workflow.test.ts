import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

// The repository CI builds a package with the generated templates and then repeats the Agent smoke
// the generated project's package-smoke workflow runs, instead of calling it. The two copies have to
// stay identical: the runtime-reuse change updated only the template, so CI kept importing `maa`
// against the wheel copy the release build deliberately strips and failed on every push.
const IMPORT_COMMAND_PATTERN = /-I -c '([^']+)'/g
const CI_WORKFLOW = new URL('../.github/workflows/ci.yml', import.meta.url)
const GENERATED_PACKAGE_SMOKE_WORKFLOW = new URL(
  '../templates/addons/github/.github/workflows/package-smoke.yml',
  import.meta.url,
)

async function agentImportCommands(workflow: URL): Promise<string[]> {
  const text = (await readFile(workflow, 'utf8')).replace(/\r\n/g, '\n')
  return Array.from(text.matchAll(IMPORT_COMMAND_PATTERN), (match) => match[1] ?? '')
}

describe('package smoke workflow', () => {
  it('reuses the generated workflow Agent import smoke verbatim', async () => {
    const [ci, generated] = await Promise.all([
      agentImportCommands(CI_WORKFLOW),
      agentImportCommands(GENERATED_PACKAGE_SMOKE_WORKFLOW),
    ])

    expect(ci.length).toBeGreaterThan(0)
    expect(new Set([...ci, ...generated]).size).toBe(1)
  })

  it('resolves the shared MaaFW runtime before anything imports maa', async () => {
    const commands = await agentImportCommands(CI_WORKFLOW)
    expect(commands).toHaveLength(2) // the pwsh and bash variants

    for (const command of commands) {
      // Importing utils pulls in maa, which pins its library directory for the rest of the process,
      // so the runtime has to be resolved first or it falls back to the stripped wheel copy.
      expect(command).toContain('ensure_maafw_binary_path()')
      expect(command.indexOf('import maafw_paths')).toBeLessThan(command.indexOf('import agent_runtime'))
    }
  })

  // The osx leg also exercises the whole dmg pipeline the release uses — enabling MXU, bundling,
  // signing and running the app read-only — so the bundler cannot rot on the CI platforms that
  // only build flat packages.
  it('exercises the macOS app bundler on the osx package-smoke leg', async () => {
    const text = (await readFile(CI_WORKFLOW, 'utf8')).replace(/\r\n/g, '\n')
    for (const marker of [
      "mxu: {enabled: true, channel: 'stable', version: ''}",
      'node tools/macos-app-bundle.mjs',
      '--package dist/package-mxu',
      '--executable ci-package',
      '--icon logo.ico',
      'smoke-macos-app.sh "dist/CI-Package.app"',
      'codesign --verify --strict',
    ]) {
      expect(text).toContain(marker)
    }
    expect(text.indexOf('node tools/macos-app-bundle.mjs')).toBeGreaterThan(text.indexOf('mxu: {enabled: true'))
    expect(text.indexOf('smoke-macos-app.sh')).toBeGreaterThan(text.indexOf('node tools/macos-app-bundle.mjs'))
    // The bundler steps only exist on the macOS leg of the matrix.
    expect(text.match(/if: runner\.os == 'macOS'/g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })
})
