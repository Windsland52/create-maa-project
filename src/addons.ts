const CREATE_ADDONS = new Set([
  'dev-tools',
  'vscode',
  'github',
  'agent',
  'resource-pack',
  'git-cliff',
  'auto-format',
  'optimize-images',
  'community',
  'dependabot',
  'schema-sync',
])
const INCREMENTAL_ADDONS = new Set([
  'dev-tools',
  'vscode',
  'github',
  'agent',
  'resource-pack',
  'git-cliff',
  'auto-format',
  'optimize-images',
  'community',
  'dependabot',
  'schema-sync',
])
const DEFAULT_INCLUDED_ADDONS = new Set<string>()
const PLANNED_ADDONS = new Set<string>()
const V1_RESERVED_ADDONS = new Set([
  'i18n',
  'mirrorchyan',
  'branding',
])

/**
 * Canonical add-on order. Dependencies always appear before the add-ons that need them.
 */
export const ADDON_ORDER = [
  'dev-tools',
  'vscode',
  'github',
  'agent',
  'resource-pack',
  'git-cliff',
  'auto-format',
  'optimize-images',
  'community',
  'dependabot',
  'schema-sync',
] as const

/**
 * Declarative add-on dependency graph: each entry lists the add-ons that must be enabled
 * together with it. This is the single source of truth for `resolveAddonDependencies`,
 * the interactive feature prompt, and the dependency text in `--help`.
 */
export const ADDON_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  'dev-tools': [],
  vscode: [
    'dev-tools',
  ],
  github: [
    'dev-tools',
  ],
  agent: [
    'dev-tools',
    'vscode',
  ],
  'resource-pack': [],
  'git-cliff': [
    'github',
  ],
  'auto-format': [
    'github',
  ],
  'optimize-images': [
    'github',
  ],
  community: [
    'github',
  ],
  dependabot: [
    'github',
  ],
  'schema-sync': [
    'github',
  ],
}

/** Add-ons that write a state entry into `maa-project.json`. */
export const ADDON_CONFIG_KEYS: Readonly<Record<string, string>> = {
  'dev-tools': 'devTools',
  vscode: 'vscode',
  github: 'github',
  'git-cliff': 'gitCliff',
  'auto-format': 'autoFormat',
  'optimize-images': 'optimizeImages',
  dependabot: 'dependabot',
  community: 'community',
  'schema-sync': 'schemaSync',
}

const SUPPORTED_INCREMENTAL_LIST = ADDON_ORDER.join(', ')
const DEFAULT_INCLUDED_LIST = 'none'

/** Every add-on that must be present for `addon`, following dependencies transitively. */
export function requiredAddonsFor(addon: string): string[] {
  const required = new Set<string>()
  const visit = (name: string): void => {
    for (const dependency of ADDON_DEPENDENCIES[name] ?? []) {
      if (required.has(dependency)) continue
      required.add(dependency)
      visit(dependency)
    }
  }
  visit(addon)
  return [
    ...ADDON_ORDER.filter((candidate) => required.has(candidate)),
    ...[...required].filter((candidate) => !(ADDON_ORDER as readonly string[]).includes(candidate)),
  ]
}

/**
 * Nesting level of an add-on for indented prompts: 0 for a root feature such as
 * dev-tools, 1 for github, 2 for a feature that requires github.
 */
export function addonDependencyDepth(addon: string): number {
  const required = requiredAddonsFor(addon)
  return required.length === 0 ? 0 : Math.max(...required.map((name) => addonDependencyDepth(name))) + 1
}

/**
 * Depth-first order for an indented list: each add-on is immediately followed by the add-ons
 * that require it, so the indentation renders a coherent tree. Without this, an add-on that
 * merely sits at the same level would split a parent from its own children.
 */
export function addonTreeOrder(addons: readonly string[]): string[] {
  const included = new Set(addons)
  const dependents = new Map(addonDependencyGroups().map((group) => [group.addon, group.dependents]))
  const ordered: string[] = []
  const visited = new Set<string>()
  const visit = (addon: string): void => {
    if (visited.has(addon) || !included.has(addon)) return
    visited.add(addon)
    ordered.push(addon)
    for (const dependent of dependents.get(addon) ?? []) visit(dependent)
  }

  const hasIncludedRequirement = (addon: string): boolean =>
    requiredAddonsFor(addon).some((dependency) => included.has(dependency))

  for (const addon of ADDON_ORDER) if (!hasIncludedRequirement(addon)) visit(addon)
  for (const addon of ADDON_ORDER) visit(addon)
  return ordered
}

export function assertSupportedCreateAddons(addons: string[]): void {
  for (const addon of addons) {
    if (CREATE_ADDONS.has(addon)) continue
    throw new Error(createAddonUnavailableMessage(addon))
  }
}

export function isIncrementalAddon(addon: string): boolean {
  return INCREMENTAL_ADDONS.has(addon)
}

export function isDefaultIncludedAddon(addon: string): boolean {
  return DEFAULT_INCLUDED_ADDONS.has(addon)
}

export function resolveAddonDependencies(addons: string[], input: { includeAgent?: boolean } = {}): string[] {
  const requested = addons
  const resolved = new Set(requested)
  for (const addon of requested) {
    for (const dependency of requiredAddonsFor(addon)) resolved.add(dependency)
  }
  // The agent template needs everything the agent add-on needs - the developer tooling and the
  // VS Code debug configuration - without the caller listing those add-ons.
  if (input.includeAgent) {
    for (const dependency of ADDON_DEPENDENCIES.agent ?? []) resolved.add(dependency)
  }
  return [
    ...ADDON_ORDER.filter((addon) => resolved.has(addon)),
    ...requested.filter((addon) => !(ADDON_ORDER as readonly string[]).includes(addon)),
  ]
}

/**
 * Add-ons that were enabled because another selection requires them, in canonical order.
 * Used to explain the difference between what a caller asked for and what it received.
 */
export function autoEnabledAddons(requested: string[], resolved: string[]): string[] {
  const asked = new Set(requested)
  return resolved.filter((addon) => !asked.has(addon))
}

/** Dependency graph grouped by requirement: which add-ons need each add-on. */
export function addonDependencyGroups(): { addon: string; dependents: string[] }[] {
  const groups = new Map<string, string[]>()
  for (const addon of ADDON_ORDER) {
    for (const dependency of ADDON_DEPENDENCIES[addon] ?? []) {
      groups.set(dependency, [
        ...(groups.get(dependency) ?? []),
        addon,
      ])
    }
  }
  return [...groups].map(([addon, dependents]) => ({ addon, dependents }))
}

/** Human-readable dependency rule, derived from the graph so it cannot drift. */
export function addonDependencyText(): string {
  const clauses = addonDependencyGroups().map(
    ({ addon, dependents }) => `${addon} is required by ${joinList(dependents)}`,
  )
  return `Dependencies are enabled automatically: ${clauses.join('; ')}.`
}

/** The same rule as one indented line per dependency, for `--help`. */
export function addonDependencyLines(): string[] {
  return [
    'Dependencies are enabled automatically:',
    ...addonDependencyGroups().map(({ addon, dependents }) => `  ${addon}: ${dependents.join(', ')}`),
  ]
}

function joinList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? ''
  return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`
}

export function defaultIncludedAddonMessage(addon: string): string {
  return `${addon} is already included in the default template.`
}

export function incrementalAddonUnavailableMessage(addon: string): string {
  return addonUnavailableMessage(addon)
}

function createAddonUnavailableMessage(addon: string): string {
  if (INCREMENTAL_ADDONS.has(addon)) {
    return `--add ${addon} can only be applied inside an existing project in this version.`
  }
  return addonUnavailableMessage(addon)
}

function addonUnavailableMessage(addon: string): string {
  if (PLANNED_ADDONS.has(addon)) {
    return `--add ${addon} is planned but is not implemented in this version.`
  }
  if (V1_RESERVED_ADDONS.has(addon)) {
    return `--add ${addon} is reserved for v1.x and is not implemented in this version.`
  }
  return `Unsupported add-on: ${addon}. Supported incremental add-ons: ${SUPPORTED_INCREMENTAL_LIST}. Default included add-ons: ${DEFAULT_INCLUDED_LIST}.`
}
