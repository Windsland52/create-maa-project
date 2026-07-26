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
  return (
    isAddonEnabled(config, 'devTools') ||
    config.features.quality.enabled ||
    config.features.vscode.enabled ||
    config.python !== undefined
  )
}

export function hasGithubAutomation(config: MaaProjectConfig): boolean {
  return isAddonEnabled(config, 'github') || config.features.ci.enabled || config.features.release.enabled
}
