import type { ControllerKind, MaaProjectConfig } from './types.js'

export const CONTROLLER_KINDS: ControllerKind[] = [
  'Adb',
  'Win32',
  'MacOS',
  'PlayCover',
  'Gamepad',
  'WlRoots'
]

export const DEFAULT_CONTROLLER_KINDS: ControllerKind[] = [
  'Adb'
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
    case 'wlroots':
    case 'wl-roots':
      return 'WlRoots'
    default:
      return undefined
  }
}

export function parseControllerKinds(value: string): ControllerKind[] {
  const kinds = value
    .split(',')
    .map((item) => normalizeControllerKind(item))
    .filter((item): item is ControllerKind => item !== undefined)
  return uniqueControllerKinds(kinds)
}

export function assertControllerKinds(kinds: ControllerKind[], label = '--controller'): void {
  if (kinds.length === 0) {
    throw new Error(`${label} must include at least one control target.`)
  }
}

export function controllerUnavailableMessage(value: string): string {
  return `Unsupported controller: ${value}. Supported controllers: ${CONTROLLER_KINDS.join(', ')}.`
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
    if (kind) return [
        kind
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
