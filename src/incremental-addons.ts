import {
  defaultIncludedAddonMessage,
  incrementalAddonUnavailableMessage,
  isDefaultIncludedAddon,
  isIncrementalAddon,
  resolveAddonDependencies,
} from './addons.js'
import {
  addAgent,
  addAutoFormat,
  addCommunity,
  addDependabot,
  addDevTools,
  addGitCliff,
  addGithub,
  addOptimizeImages,
  addResourcePack,
  addSchemaSync,
} from './scaffold.js'
import type { CliOptions, ScaffoldResult } from './types.js'

export async function applyIncrementalAddons(
  options: CliOptions,
  writeLine: (line: string) => void = console.log,
): Promise<ScaffoldResult | undefined> {
  let combinedResult: ScaffoldResult | undefined
  for (const addon of resolveAddonDependencies(options.add)) {
    if (!isIncrementalAddon(addon)) {
      if (isDefaultIncludedAddon(addon)) {
        writeLine(defaultIncludedAddonMessage(addon))
        continue
      }
      throw new Error(incrementalAddonUnavailableMessage(addon))
    }
    let result: ScaffoldResult | undefined
    if (addon === 'dev-tools') {
      result = await addDevTools(options)
    } else if (addon === 'github') {
      result = await addGithub(options)
    } else if (addon === 'agent') {
      result = await addAgent(options)
    } else if (addon === 'resource-pack') {
      result = await addResourcePack(options)
    } else if (addon === 'git-cliff') {
      result = await addGitCliff(options)
    } else if (addon === 'auto-format') {
      result = await addAutoFormat(options)
    } else if (addon === 'optimize-images') {
      result = await addOptimizeImages(options)
    } else if (addon === 'community') {
      result = await addCommunity(options)
    } else if (addon === 'dependabot') {
      result = await addDependabot(options)
    } else if (addon === 'schema-sync') {
      result = await addSchemaSync(options)
    }
    if (result) combinedResult = mergeScaffoldResults(combinedResult, result)
  }
  return combinedResult
}

function mergeScaffoldResults(previous: ScaffoldResult | undefined, next: ScaffoldResult): ScaffoldResult {
  const git = next.git ?? previous?.git
  return {
    root: next.root,
    config: next.config,
    written: appendUnique(previous?.written ?? [], next.written),
    skipped: appendUnique(previous?.skipped ?? [], next.skipped),
    pending: mergePending(previous?.pending ?? [], next.pending),
    ...(git ? { git } : {}),
  }
}

function appendUnique(existing: string[], next: string[]): string[] {
  return [
    ...new Set([
      ...existing,
      ...next,
    ]),
  ]
}

function mergePending(existing: ScaffoldResult['pending'], next: ScaffoldResult['pending']): ScaffoldResult['pending'] {
  const pendingByAction = new Map<string, ScaffoldResult['pending'][number]>()
  for (const item of existing) pendingByAction.set(pendingKey(item), item)
  for (const item of next) pendingByAction.set(pendingKey(item), item)
  return [...pendingByAction.values()]
}

function pendingKey(item: ScaffoldResult['pending'][number]): string {
  return `${item.kind}\0${item.command}`
}
