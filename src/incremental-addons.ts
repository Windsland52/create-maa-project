import {
    defaultIncludedAddonMessage,
    incrementalAddonUnavailableMessage,
    isDefaultIncludedAddon
} from './addons.js'
import { addSchemaSync } from './scaffold.js'
import type { CliOptions, ScaffoldResult } from './types.js'

type IncrementalAddonHandler = (options: CliOptions) => Promise<ScaffoldResult>

const INCREMENTAL_ADDON_HANDLERS: Record<string, IncrementalAddonHandler> = {
    'schema-sync': addSchemaSync
}

export async function applyIncrementalAddons(
    options: CliOptions,
    writeLine: (line: string) => void = console.log
): Promise<ScaffoldResult | undefined> {
    let lastResult: ScaffoldResult | undefined
    for (const addon of options.add) {
        const handler = INCREMENTAL_ADDON_HANDLERS[addon]
        if (!handler) {
            if (isDefaultIncludedAddon(addon)) {
                writeLine(defaultIncludedAddonMessage(addon))
                continue
            }
            throw new Error(incrementalAddonUnavailableMessage(addon))
        }
        lastResult = await handler(options)
    }
    return lastResult
}
