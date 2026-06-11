import { describe, expect, it } from 'vitest'
import { applyIncrementalAddons } from '../src/incremental-addons.js'
import type { CliOptions } from '../src/types.js'

describe('applyIncrementalAddons', () => {
    it('reports default included add-ons without writing project files', async () => {
        const lines: string[] = []

        await expect(
            applyIncrementalAddons(options(['ci']), (line) => lines.push(line))
        ).resolves.toBeUndefined()

        expect(lines).toEqual(['ci is already included in the default template.'])
    })

    it('rejects planned add-ons until handlers are registered', async () => {
        await expect(applyIncrementalAddons(options(['git-cliff']))).rejects.toThrow(
            '--add git-cliff is planned but is not implemented in this version.'
        )
    })

    it('rejects unknown add-ons with the current support summary', async () => {
        await expect(applyIncrementalAddons(options(['unknown-addon']))).rejects.toThrow(
            'Supported incremental add-ons: agent, resource-pack, changelog, community, dependabot, schema-sync'
        )
    })
})

function options(add: string[]): CliOptions {
    return {
        template: 'pipeline',
        add,
        update: [],
        doctor: false,
        diff: false,
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
        acceptChanges: [],
        acceptChangesRequested: false,
        cleanCache: false,
        report: false,
        explicitTemplate: false
    }
}
