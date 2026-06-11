import type { MaaProjectConfig } from './types.js'

export function hasDevTools(config: MaaProjectConfig): boolean {
    return (
        Boolean(config.addons.devTools) ||
        config.features.quality.enabled ||
        config.features.vscode.enabled ||
        config.python !== undefined
    )
}

export function hasGithubAutomation(config: MaaProjectConfig): boolean {
    return Boolean(config.addons.github) || config.features.ci.enabled || config.features.release.enabled
}
