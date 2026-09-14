import type { ControllerKind, MaaProjectConfig } from './types.js'

/** MaaFW's controller enum: `--controller`, `maa-project.json` and `interface.json` all use it. */
export const CONTROLLER_KINDS: ControllerKind[] = [
  'Adb',
  'Win32',
  'MacOS',
  'PlayCover',
  'Gamepad',
  'Linux',
]

export const DEFAULT_CONTROLLER_KINDS: ControllerKind[] = [
  'Adb',
]

/**
 * Spellings accepted from projects and scripts written before the kind was renamed to MaaFW's own
 * `Linux`. They normalize to it on read, so an existing `maa-project.json` keeps working, but the
 * CLI only ever writes `CONTROLLER_KINDS` back.
 */
export const LEGACY_CONTROLLER_KINDS = [
  'WlRoots',
] as const

/** Everything `controller.kinds` and the MCP tool accept, canonical kinds first. */
export const CONTROLLER_KIND_INPUTS: string[] = [
  ...CONTROLLER_KINDS,
  ...LEGACY_CONTROLLER_KINDS,
]

export function normalizeControllerKind(value: string): ControllerKind | undefined {
  const normalized = value.trim().toLowerCase()
  switch (normalized) {
    case 'adb':
    case 'android':
      return 'Adb'
    case 'win32':
    case 'windows':
      return 'Win32'
    case 'macos':
    case 'mac':
      return 'MacOS'
    case 'playcover':
      return 'PlayCover'
    case 'gamepad':
      return 'Gamepad'
    case 'linux':
      return 'Linux'
    // Spellings from projects created before the rename.
    case 'wlroots':
    case 'wl-roots':
      return 'Linux'
    default:
      return undefined
  }
}

export function controllerUnavailableMessage(value: string): string {
  return `Unsupported controller: ${value}. Supported controllers: ${CONTROLLER_KINDS.join(', ')}.`
}

/** Normalizes one controller value, throwing for a target the CLI does not know. */
export function parseControllerKind(value: string): ControllerKind {
  const kind = normalizeControllerKind(value)
  if (kind === undefined) throw new Error(controllerUnavailableMessage(value.trim() || value))
  return kind
}

export function projectControllerKinds(config: MaaProjectConfig): ControllerKind[] {
  const controller = (
    config as MaaProjectConfig & {
      controller?: {
        kinds?: unknown
        kind?: unknown
      }
    }
  ).controller
  if (Array.isArray(controller?.kinds)) {
    const kinds = (controller.kinds as unknown[])
      .filter((item): item is string => typeof item === 'string')
      .map((item) => normalizeControllerKind(item))
      .filter((item): item is ControllerKind => item !== undefined)
    const unique = uniqueControllerKinds(kinds)
    return unique.length > 0 ? unique : DEFAULT_CONTROLLER_KINDS
  }
  if (typeof controller?.kind === 'string') {
    if (controller.kind === 'None') return []
    const kind = normalizeControllerKind(controller.kind)
    if (kind)
      return [
        kind,
      ]
  }
  return DEFAULT_CONTROLLER_KINDS
}

export function uniqueControllerKinds(kinds: ControllerKind[]): ControllerKind[] {
  const seen = new Set<ControllerKind>()
  const result: ControllerKind[] = []
  for (const kind of kinds) {
    if (seen.has(kind)) continue
    seen.add(kind)
    result.push(kind)
  }
  return result
}
