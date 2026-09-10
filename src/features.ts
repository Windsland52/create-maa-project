import type { MaaProjectConfig, ResourcePackConfig } from './types.js'

export function isAddonEnabled(config: MaaProjectConfig, name: string): boolean {
  const state = config.addons[name]
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    const enabled = (state as Record<string, unknown>).enabled
    return enabled === undefined || enabled === true
  }
  return Boolean(state)
}

export function enabledResourcePacks(config: MaaProjectConfig): ResourcePackConfig[] {
  return config.resources.filter((pack) => pack.enabled)
}

export function hasDevTools(config: MaaProjectConfig): boolean {
  return isAddonEnabled(config, 'devTools') || config.features.quality.enabled || config.python !== undefined
}

/**
 * Editor integration is its own add-on: `vscode` requires `dev-tools`, so this never implies
 * dev tools. Check `features.vscode` because it is the field the doctor check and older
 * projects already carry.
 */
export function hasVscode(config: MaaProjectConfig): boolean {
  return isAddonEnabled(config, 'vscode') || config.features.vscode.enabled
}

export function hasGithubAutomation(config: MaaProjectConfig): boolean {
  return isAddonEnabled(config, 'github') || config.features.ci.enabled || config.features.release.enabled
}
