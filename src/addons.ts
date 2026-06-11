const CREATE_ADDONS = new Set(['dev-tools', 'github', 'agent', 'resource-pack', 'changelog', 'community', 'dependabot', 'schema-sync'])
const INCREMENTAL_ADDONS = new Set(['dev-tools', 'github', 'agent', 'resource-pack', 'changelog', 'community', 'dependabot', 'schema-sync'])
const DEFAULT_INCLUDED_ADDONS = new Set<string>()
const PLANNED_ADDONS = new Set(['auto-format', 'optimize-images', 'git-cliff'])
const V1_RESERVED_ADDONS = new Set(['i18n', 'mirrorchyan', 'branding'])

const SUPPORTED_INCREMENTAL_LIST = 'dev-tools, github, agent, resource-pack, changelog, community, dependabot, schema-sync'
const DEFAULT_INCLUDED_LIST = 'none'

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
    const resolved = new Set(addons)
    if (input.includeAgent || resolved.has('agent')) resolved.add('dev-tools')
    if (resolved.has('github') || resolved.has('schema-sync') || resolved.has('community') || resolved.has('dependabot')) {
        resolved.add('dev-tools')
    }
    if (resolved.has('schema-sync') || resolved.has('community') || resolved.has('dependabot')) {
        resolved.add('github')
    }
    const order = ['dev-tools', 'github', 'agent', 'resource-pack', 'changelog', 'community', 'dependabot', 'schema-sync']
    return [...order.filter((addon) => resolved.has(addon)), ...addons.filter((addon) => !order.includes(addon))]
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
