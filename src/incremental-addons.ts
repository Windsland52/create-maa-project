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
import { withProjectWriteLock } from './project.js'
import { throwIfAborted } from './utils.js'

export async function applyIncrementalAddons(
  options: CliOptions,
  writeLine: (line: string) => void = console.log,
  root = process.cwd(),
  operationCommand = process.argv.join(' '),
  signal?: AbortSignal,
): Promise<ScaffoldResult | undefined> {
  throwIfAborted(signal)
  const addons = resolveAddonDependencies(options.add)
  if (addons.length === 0) return undefined
  return withProjectWriteLock(
    root,
    operationCommand,
    async (operation) => {
      throwIfAborted(signal)
      let combinedResult: ScaffoldResult | undefined
      for (const addon of addons) {
        throwIfAborted(signal)
        if (!isIncrementalAddon(addon)) {
          if (isDefaultIncludedAddon(addon)) {
            writeLine(defaultIncludedAddonMessage(addon))
            throwIfAborted(signal)
            continue
          }
          throw new Error(incrementalAddonUnavailableMessage(addon))
        }
        let result: ScaffoldResult | undefined
        if (addon === 'dev-tools') {
          result = await addDevTools(options, root)
        } else if (addon === 'github') {
          result = await addGithub(options, root)
        } else if (addon === 'agent') {
          result = await addAgent(options, root)
        } else if (addon === 'resource-pack') {
          result = await addResourcePack(options, root)
        } else if (addon === 'git-cliff') {
          result = await addGitCliff(options, root)
        } else if (addon === 'auto-format') {
          result = await addAutoFormat(options, root)
        } else if (addon === 'optimize-images') {
          result = await addOptimizeImages(options, root)
        } else if (addon === 'community') {
          result = await addCommunity(options, root)
        } else if (addon === 'dependabot') {
          result = await addDependabot(options, root)
        } else if (addon === 'schema-sync') {
          result = await addSchemaSync(options, root)
        }
        throwIfAborted(signal)
        if (result) combinedResult = mergeScaffoldResults(combinedResult, result)
      }
      return combinedResult ? { ...combinedResult, backupId: operation.backupId } : undefined
    },
    { clearStale: options.clearStaleLock },
  )
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
