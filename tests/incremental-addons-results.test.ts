import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliOptions, MaaProjectConfig, PendingItem, ScaffoldResult } from '../src/types.js'

const addonMocks = vi.hoisted(() => ({
  addDevTools: vi.fn(),
  addGithub: vi.fn(),
  addAgent: vi.fn(),
  addResourcePack: vi.fn(),
  addGitCliff: vi.fn(),
  addAutoFormat: vi.fn(),
  addOptimizeImages: vi.fn(),
  addCommunity: vi.fn(),
  addDependabot: vi.fn(),
  addSchemaSync: vi.fn(),
}))

vi.mock('../src/scaffold.js', () => addonMocks)
vi.mock('../src/project.js', () => ({
  withProjectWriteLock: vi.fn(
    async (_root: string, _command: string, action: (operation: { backupId: string }) => Promise<unknown>) =>
      action({ backupId: 'backup-add-operation' }),
  ),
}))

import { applyIncrementalAddons } from '../src/incremental-addons.js'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('incremental add-on result aggregation', () => {
  it('keeps and deterministically deduplicates results from dependencies and requested add-ons', async () => {
    const calls: string[] = []
    const devToolsConfig = projectConfig({ devTools: { enabled: true } })
    const finalConfig = projectConfig({
      devTools: { enabled: true },
      github: { enabled: true },
    })
    const earlyNodePending: PendingItem = {
      kind: 'node-deps',
      reason: 'Install dependencies introduced by dev tools.',
      command: 'create-maa-project --update node-deps',
    }
    const earlySchemaPending: PendingItem = {
      kind: 'schema',
      reason: 'Refresh the initial schema baseline.',
      command: 'create-maa-project --update schema',
    }
    const finalSchemaPending: PendingItem = {
      ...earlySchemaPending,
      reason: 'Refresh the schema baseline required by all selected add-ons.',
    }
    const runtimePending: PendingItem = {
      kind: 'runtime',
      reason: 'Download the selected runtime.',
      command: 'create-maa-project --update runtime:mfa',
    }

    addonMocks.addDevTools.mockImplementation(async () => {
      calls.push('dev-tools')
      return scaffoldResult(devToolsConfig, {
        written: [
          'package.json',
          'maa-project.json',
        ],
        skipped: [
          'README.md',
          'CONTRIBUTING.md',
        ],
        pending: [
          earlyNodePending,
          earlySchemaPending,
        ],
      })
    })
    addonMocks.addGithub.mockImplementation(async () => {
      calls.push('github')
      return scaffoldResult(finalConfig, {
        written: [
          'maa-project.json',
          '.github/workflows/check.yml',
        ],
        skipped: [
          'README.md',
          'LICENSE',
        ],
        pending: [
          finalSchemaPending,
          runtimePending,
        ],
      })
    })

    const result = await applyIncrementalAddons(
      options([
        'github',
      ]),
    )

    expect(calls).toEqual([
      'dev-tools',
      'github',
    ])
    expect(result?.root).toBe('C:/project')
    expect(result?.config).toBe(finalConfig)
    expect(result?.backupId).toBe('backup-add-operation')
    expect(result?.written).toEqual([
      'package.json',
      'maa-project.json',
      '.github/workflows/check.yml',
    ])
    expect(result?.skipped).toEqual([
      'README.md',
      'CONTRIBUTING.md',
      'LICENSE',
    ])
    expect(result?.pending).toEqual([
      earlyNodePending,
      finalSchemaPending,
      runtimePending,
    ])
  })

  it('returns undefined when no add-on target is requested', async () => {
    await expect(applyIncrementalAddons(options([]))).resolves.toBeUndefined()
    expect(addonMocks.addDevTools).not.toHaveBeenCalled()
  })

  it('stops before the next add-on when the request is cancelled', async () => {
    const controller = new AbortController()
    addonMocks.addDevTools.mockImplementation(async () => {
      controller.abort('add cancelled')
      return scaffoldResult(projectConfig({ devTools: { enabled: true } }), {
        written: ['package.json'],
        skipped: [],
        pending: [],
      })
    })

    await expect(
      applyIncrementalAddons(
        options([
          'github',
        ]),
        () => undefined,
        'C:/project',
        'MCP add',
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'add cancelled' })
    expect(addonMocks.addGithub).not.toHaveBeenCalled()
  })
})

function scaffoldResult(
  config: MaaProjectConfig,
  result: Pick<ScaffoldResult, 'written' | 'skipped' | 'pending'>,
): ScaffoldResult {
  return {
    root: 'C:/project',
    config,
    ...result,
  }
}

function projectConfig(addons: Record<string, unknown>): MaaProjectConfig {
  return {
    schemaVersion: 2,
    project: {
      slug: 'project',
      displayName: 'Project',
      version: '0.1.0',
      initialTemplate: 'pipeline',
    },
    features: {
      ci: { enabled: Boolean(addons.github) },
      release: { enabled: Boolean(addons.github) },
      vscode: { enabled: Boolean(addons.devTools) },
      quality: { enabled: Boolean(addons.devTools) },
    },
    addons,
    controller: {
      kinds: [
        'Adb',
      ],
    },
    resources: [],
    maafw: {
      channel: 'stable',
    },
    runtime: {
      mfa: {
        channel: 'stable',
        enabled: Boolean(addons.github),
      },
    },
    network: {
      mode: 'auto',
    },
    license: {
      spdx: 'AGPL-3.0-or-later',
    },
  }
}

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
