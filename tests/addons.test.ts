import { describe, expect, it } from 'vitest'
import { resolveAddonDependencies } from '../src/addons.js'
import { applyIncrementalAddons } from '../src/incremental-addons.js'
import type { CliOptions } from '../src/types.js'

describe('applyIncrementalAddons', () => {
    it('resolves add-on dependencies in template order', () => {
        expect(resolveAddonDependencies(['schema-sync'])).toEqual(['dev-tools', 'github', 'schema-sync'])
        expect(resolveAddonDependencies(['community'])).toEqual(['dev-tools', 'github', 'community'])
        expect(resolveAddonDependencies(['git-cliff'])).toEqual(['dev-tools', 'github', 'git-cliff'])
        expect(resolveAddonDependencies(['auto-format'])).toEqual(['dev-tools', 'github', 'auto-format'])
        expect(resolveAddonDependencies(['optimize-images'])).toEqual(['dev-tools', 'github', 'optimize-images'])
        expect(resolveAddonDependencies(['agent'])).toEqual(['dev-tools', 'agent'])
    })

    it('rejects old default feature names as unsupported add-ons', async () => {
        await expect(
            applyIncrementalAddons(options(['ci']))
        ).rejects.toThrow('Unsupported add-on: ci')
        await expect(
            applyIncrementalAddons(options(['changelog']))
        ).rejects.toThrow('Unsupported add-on: changelog')
    })

    it('rejects reserved add-ons until handlers are registered', async () => {
        await expect(applyIncrementalAddons(options(['mirrorchyan']))).rejects.toThrow(
            '--add mirrorchyan is reserved for v1.x and is not implemented in this version.'
        )
    })

    it('rejects unknown add-ons with the current support summary', async () => {
        await expect(applyIncrementalAddons(options(['unknown-addon']))).rejects.toThrow(
            'Supported incremental add-ons: dev-tools, github, agent, resource-pack, git-cliff, auto-format, optimize-images, community, dependabot, schema-sync'
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
