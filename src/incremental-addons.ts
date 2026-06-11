import {
    defaultIncludedAddonMessage,
    incrementalAddonUnavailableMessage,
    isDefaultIncludedAddon,
    isIncrementalAddon,
    resolveAddonDependencies
} from './addons.js'
import {
    addAgent,
    addCommunity,
    addDependabot,
    addDevTools,
    addGitCliff,
    addGithub,
    addResourcePack,
    addSchemaSync
} from './scaffold.js'
import type { CliOptions, ScaffoldResult } from './types.js'

export async function applyIncrementalAddons(
    options: CliOptions,
    writeLine: (line: string) => void = console.log
): Promise<ScaffoldResult | undefined> {
    let lastResult: ScaffoldResult | undefined
    for (const addon of resolveAddonDependencies(options.add)) {
        if (!isIncrementalAddon(addon)) {
            if (isDefaultIncludedAddon(addon)) {
                writeLine(defaultIncludedAddonMessage(addon))
                continue
            }
            throw new Error(incrementalAddonUnavailableMessage(addon))
        }
        if (addon === 'dev-tools') {
            lastResult = await addDevTools(options)
        } else if (addon === 'github') {
            lastResult = await addGithub(options)
        } else if (addon === 'agent') {
            lastResult = await addAgent(options)
        } else if (addon === 'resource-pack') {
            lastResult = await addResourcePack(options)
        } else if (addon === 'git-cliff') {
            lastResult = await addGitCliff(options)
        } else if (addon === 'community') {
            lastResult = await addCommunity(options)
        } else if (addon === 'dependabot') {
            lastResult = await addDependabot(options)
        } else if (addon === 'schema-sync') {
            lastResult = await addSchemaSync(options)
        }
    }
    return lastResult
}
