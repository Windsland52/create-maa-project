import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../src/args.js'
import { runDoctor } from '../src/doctor.js'
import { enabledResourcePacks, hasDevTools, hasGithubAutomation, isAddonEnabled } from '../src/features.js'
import { readProjectConfig } from '../src/project.js'
import { createProject } from '../src/scaffold.js'
import { syncProject } from '../src/sync.js'
import type { MaaProjectConfig } from '../src/types.js'
import { recordUpdateRequests } from '../src/update.js'

const originalCwd = process.cwd()
const tempRoots: string[] = []

afterEach(async () => {
  process.chdir(originalCwd)
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('enabled project config semantics', () => {
  it('honors disabled addon state objects instead of treating them as truthy', async () => {
    const root = await createTempProject('disabled-addons')
    const config = await readProjectConfig(root)
    config.features.vscode.enabled = false
    config.features.quality.enabled = false
    config.features.ci.enabled = false
    config.features.release.enabled = false

    config.addons.devTools = { enabled: false }
    config.addons.github = { enabled: false }
    expect(isAddonEnabled(config, 'devTools')).toBe(false)
    expect(isAddonEnabled(config, 'github')).toBe(false)
    expect(hasDevTools(config)).toBe(false)
    expect(hasGithubAutomation(config)).toBe(false)

    config.addons.devTools = { enabled: true }
    config.addons.github = true
    expect(hasDevTools(config)).toBe(true)
    expect(hasGithubAutomation(config)).toBe(true)
  })

  it('omits disabled resource packs from synchronized interfaces and doctor path checks', async () => {
    const root = await createTempProject('disabled-resource')
    const configPath = join(root, 'maa-project.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as MaaProjectConfig
    config.resources.push({
      slug: 'disabled',
      label: 'Disabled',
      path: 'resource/does-not-exist',
      enabled: false,
    })
    await writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`, 'utf8')

    const result = await syncProject(parseArgs(['--sync', 'metadata']), { root })
    const interfaceJson = JSON.parse(await readFile(join(root, 'interface.json'), 'utf8')) as {
      resource: Array<{ name: string }>
    }
    const doctor = await runDoctor(root)

    expect(enabledResourcePacks(result.config).map((pack) => pack.slug)).toEqual([
      'base',
    ])
    expect(interfaceJson.resource.map((resource) => resource.name)).toEqual([
      'base',
    ])
    expect(doctor.lines.join('\n')).not.toContain('resource/does-not-exist')
  })

  it('skips an explicitly disabled MFA runtime without resolving or downloading assets', async () => {
    const root = await createTempProject('disabled-runtime')
    const resolver = vi.fn(() => {
      throw new Error('disabled runtime must not be resolved')
    })

    const result = await recordUpdateRequests(parseArgs(['--update', 'runtime:mfa']), {
      root,
      productManifestResolver: resolver,
    })

    expect(resolver).not.toHaveBeenCalled()
    expect(result.skipped).toContain('runtime:mfa (disabled in config)')
  })
})

async function createTempProject(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'cmp-enabled-'))
  tempRoots.push(parent)
  process.chdir(parent)
  const result = await createProject(
    parseArgs([
      name,
      '--no-interactive',
      '--no-git',
      '--skip-download',
    ]),
  )
  return result.root
}
