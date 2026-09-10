import { describe, expect, it } from 'vitest'
import {
  ADDON_CONFIG_KEYS,
  ADDON_DEPENDENCIES,
  ADDON_ORDER,
  addonDependencyDepth,
  addonDependencyGroups,
  addonDependencyLines,
  addonDependencyText,
  addonTreeOrder,
  autoEnabledAddons,
  requiredAddonsFor,
  resolveAddonDependencies,
} from '../src/addons.js'
import { applyIncrementalAddons } from '../src/incremental-addons.js'
import type { CliOptions } from '../src/types.js'

/** The features the interactive prompt offers; agent and resource-pack have their own questions. */
const INTERACTIVE_FEATURE_SET = [
  'dev-tools',
  'vscode',
  'github',
  'git-cliff',
  'auto-format',
  'optimize-images',
  'community',
  'dependabot',
  'schema-sync',
]

describe('add-on dependency graph', () => {
  it('derives the same resolution as the declared graph for every add-on', () => {
    for (const addon of ADDON_ORDER) {
      expect(resolveAddonDependencies([addon])).toEqual([
        ...ADDON_ORDER.filter((name) => name === addon || requiredAddonsFor(addon).includes(name)),
      ])
    }
  })

  it('keeps dev-tools as the only root feature and orders dependencies first', () => {
    expect(addonDependencyDepth('dev-tools')).toBe(0)
    expect(addonDependencyDepth('vscode')).toBe(1)
    expect(addonDependencyDepth('github')).toBe(1)
    expect(addonDependencyDepth('git-cliff')).toBe(2)
    expect(addonDependencyDepth('community')).toBe(2)
    expect(requiredAddonsFor('git-cliff')).toEqual([
      'dev-tools',
      'github',
    ])
    expect(requiredAddonsFor('vscode')).toEqual(['dev-tools'])
    expect(requiredAddonsFor('dev-tools')).toEqual([])
  })

  it('treats vscode as a dev-tools companion rather than a dev-tools provider', () => {
    // The add-on writes editor integration for the generated toolchain, so it depends on
    // dev-tools and must never pull the toolchain in the other direction.
    expect(resolveAddonDependencies(['vscode'])).toEqual([
      'dev-tools',
      'vscode',
    ])
    expect(resolveAddonDependencies(['dev-tools'])).toEqual(['dev-tools'])
    expect(autoEnabledAddons(['vscode'], resolveAddonDependencies(['vscode']))).toEqual(['dev-tools'])
  })

  it('never lets an add-on require something outside the canonical order', () => {
    const order: readonly string[] = ADDON_ORDER
    for (const addon of ADDON_ORDER) {
      for (const dependency of ADDON_DEPENDENCIES[addon] ?? []) {
        expect(order).toContain(dependency)
        expect(order.indexOf(dependency)).toBeLessThan(order.indexOf(addon))
      }
    }
  })

  it('orders an indented list as a tree so a parent is never split from its children', () => {
    const ordered = addonTreeOrder(INTERACTIVE_FEATURE_SET)

    // vscode shares dev-tools as its parent with github, so it must not sit between github and
    // the six features that depend on github.
    expect(ordered).toEqual([
      'dev-tools',
      'vscode',
      'github',
      'git-cliff',
      'auto-format',
      'optimize-images',
      'community',
      'dependabot',
      'schema-sync',
    ])

    // Every add-on's dependents form one unbroken run directly after it.
    for (const addon of ordered) {
      const dependents = addonDependencyGroups().find((group) => group.addon === addon)?.dependents ?? []
      const present = dependents.filter((name) => ordered.includes(name))
      if (present.length === 0) continue
      const positions = present.map((name) => ordered.indexOf(name)).sort((a, b) => a - b)
      const start = positions[0] as number
      expect(positions).toEqual(positions.map((_, offset) => start + offset))
      expect(start).toBe(ordered.indexOf(addon) + 1)
    }
  })

  it('keeps every requested add-on and adds none', () => {
    const ordered = addonTreeOrder(INTERACTIVE_FEATURE_SET)

    expect([...ordered].sort()).toEqual([...INTERACTIVE_FEATURE_SET].sort())
  })

  it('describes auto-enabled add-ons as the difference between asked and resolved', () => {
    const resolved = resolveAddonDependencies([
      'community',
    ])

    expect(autoEnabledAddons(['community'], resolved)).toEqual([
      'dev-tools',
      'github',
    ])
    expect(autoEnabledAddons(resolved, resolved)).toEqual([])
  })

  it('renders the dependency rule from the graph for help and agents', () => {
    expect(addonDependencyGroups()).toEqual([
      { addon: 'dev-tools', dependents: ['vscode', 'github', 'agent'] },
      { addon: 'vscode', dependents: ['agent'] },
      {
        addon: 'github',
        dependents: [
          'git-cliff',
          'auto-format',
          'optimize-images',
          'community',
          'dependabot',
          'schema-sync',
        ],
      },
    ])
    expect(addonDependencyText()).toBe(
      'Dependencies are enabled automatically: dev-tools is required by vscode, github and agent; vscode is required by agent; github is required by git-cliff, auto-format, optimize-images, community, dependabot and schema-sync.',
    )
    expect(addonDependencyLines()).toEqual([
      'Dependencies are enabled automatically:',
      '  dev-tools: vscode, github, agent',
      '  vscode: agent',
      '  github: git-cliff, auto-format, optimize-images, community, dependabot, schema-sync',
    ])
  })

  it('maps every stateful add-on to its config key', () => {
    for (const [addon, key] of Object.entries(ADDON_CONFIG_KEYS)) {
      expect(ADDON_ORDER).toContain(addon)
      expect(key).toMatch(/^[a-z][A-Za-z]*$/)
    }
    // agent and resource-pack are recorded through features/resources, not an addon key.
    expect(ADDON_CONFIG_KEYS.agent).toBeUndefined()
    expect(ADDON_CONFIG_KEYS['resource-pack']).toBeUndefined()
  })
})

describe('applyIncrementalAddons', () => {
  it('resolves add-on dependencies in template order', () => {
    expect(
      resolveAddonDependencies([
        'schema-sync',
      ]),
    ).toEqual([
      'dev-tools',
      'github',
      'schema-sync',
    ])
    expect(
      resolveAddonDependencies([
        'community',
      ]),
    ).toEqual([
      'dev-tools',
      'github',
      'community',
    ])
    expect(
      resolveAddonDependencies([
        'git-cliff',
      ]),
    ).toEqual([
      'dev-tools',
      'github',
      'git-cliff',
    ])
    expect(
      resolveAddonDependencies([
        'auto-format',
      ]),
    ).toEqual([
      'dev-tools',
      'github',
      'auto-format',
    ])
    expect(
      resolveAddonDependencies([
        'optimize-images',
      ]),
    ).toEqual([
      'dev-tools',
      'github',
      'optimize-images',
    ])
    expect(
      resolveAddonDependencies([
        'agent',
      ]),
    ).toEqual([
      'dev-tools',
      'vscode',
      'agent',
    ])
  })

  it('rejects old default feature names as unsupported add-ons', async () => {
    await expect(
      applyIncrementalAddons(
        options([
          'ci',
        ]),
      ),
    ).rejects.toThrow('Unsupported add-on: ci')
    await expect(
      applyIncrementalAddons(
        options([
          'changelog',
        ]),
      ),
    ).rejects.toThrow('Unsupported add-on: changelog')
  })

  it('rejects reserved add-ons until handlers are registered', async () => {
    await expect(
      applyIncrementalAddons(
        options([
          'mirrorchyan',
        ]),
      ),
    ).rejects.toThrow('--add mirrorchyan is reserved for v1.x and is not implemented in this version.')
  })

  it('rejects unknown add-ons with the current support summary', async () => {
    await expect(
      applyIncrementalAddons(
        options([
          'unknown-addon',
        ]),
      ),
    ).rejects.toThrow(
      'Supported incremental add-ons: dev-tools, vscode, github, agent, resource-pack, git-cliff, auto-format, optimize-images, community, dependabot, schema-sync',
    )
  })
})

function options(add: string[]): CliOptions {
  return {
    template: 'pipeline',
    add,
    update: [],
    doctor: false,
    yes: true,
    noInteractive: true,
    force: false,
    clearStaleLock: false,
    allowNonGitDir: false,
    allowPendingCommit: false,
    skipDownload: false,
    verbose: false,
    noColor: false,
    assist: false,
    dryRun: false,
    listBackups: false,
    cleanCache: false,
    report: false,
    mcp: false,
    explicitTemplate: false,
  }
}
