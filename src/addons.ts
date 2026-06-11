const DEFAULT_INCLUDED_ADDONS = new Set(['ci', 'vscode', 'quality'])
const PLANNED_ADDONS = new Set([
    'agent',
    'resource-pack',
    'changelog',
    'community',
    'dependabot',
    'auto-format',
    'optimize-images',
    'git-cliff'
])
const V1_RESERVED_ADDONS = new Set(['i18n', 'mirrorchyan', 'branding'])

const SUPPORTED_INCREMENTAL_LIST = 'schema-sync'
const DEFAULT_INCLUDED_LIST = 'ci, vscode, quality'

export function isDefaultIncludedAddon(addon: string): boolean {
    return DEFAULT_INCLUDED_ADDONS.has(addon)
}

export function defaultIncludedAddonMessage(addon: string): string {
    return `${addon} is already included in the default template.`
}

export function incrementalAddonUnavailableMessage(addon: string): string {
    if (PLANNED_ADDONS.has(addon)) {
        return `--add ${addon} is planned but is not implemented in this version.`
    }
    if (V1_RESERVED_ADDONS.has(addon)) {
        return `--add ${addon} is reserved for v1.x and is not implemented in this version.`
    }
    return [
        `Unsupported add-on: ${addon}.`,
        `Supported incremental add-ons: ${SUPPORTED_INCREMENTAL_LIST}.`,
        `Default included add-ons: ${DEFAULT_INCLUDED_LIST}.`
    ].join(' ')
}
