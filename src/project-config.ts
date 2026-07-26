import { isValidSemVer } from './semver.js'
import type { ControllerKind, MaaProjectConfig } from './types.js'

const CONTROLLER_KINDS = [
  'Adb',
  'Win32',
  'MacOS',
  'PlayCover',
  'Gamepad',
  'WlRoots',
] as const satisfies readonly ControllerKind[]
const RELEASE_CHANNELS = [
  'stable',
  'beta',
  'alpha',
] as const

export function validateProjectConfig(value: unknown): MaaProjectConfig {
  const config = requireRecord(value, '')
  const schemaVersion = config.schemaVersion
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new Error(`Unsupported maa-project.json schemaVersion: ${String(schemaVersion)}`)
  }

  validateProject(requireRecord(config.project, 'project'))
  validateFeatures(requireRecord(config.features, 'features'))
  requireRecord(config.addons, 'addons')
  validateController(requireRecord(config.controller, 'controller'))
  validateResources(requireArray(config.resources, 'resources'))
  validateReleaseSelector(requireRecord(config.maafw, 'maafw'), 'maafw', schemaVersion === 2)

  const runtime = requireRecord(config.runtime, 'runtime')
  validateRuntimeSelector(requireRecord(runtime.mfa, 'runtime.mfa'), 'runtime.mfa', schemaVersion === 2)
  if (runtime.mxu !== undefined) {
    validateRuntimeSelector(requireRecord(runtime.mxu, 'runtime.mxu'), 'runtime.mxu', schemaVersion === 2)
  }

  if (config.ocr !== undefined) validateOcr(requireRecord(config.ocr, 'ocr'))
  if (config.python !== undefined) validatePython(requireRecord(config.python, 'python'))

  const network = requireRecord(config.network, 'network')
  requireChoice(network.mode, 'network.mode', [
    'auto',
    'official',
  ])
  const license = requireRecord(config.license, 'license')
  requireChoice(license.spdx, 'license.spdx', [
    'AGPL-3.0-or-later',
    'MIT',
    'None',
  ])

  return config as MaaProjectConfig
}

function validateProject(project: Record<string, unknown>): void {
  const slug = requireString(project.slug, 'project.slug')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,212}[a-z0-9])?$/.test(slug)) {
    invalid('project.slug', 'must use lowercase ASCII letters, numbers, and hyphens')
  }
  requireNonBlank(project.displayName, 'project.displayName')
  const version = requireString(project.version, 'project.version')
  if (!isValidSemVer(version)) invalid('project.version', 'must be a valid SemVer version such as 0.1.0')
  requireChoice(project.initialTemplate, 'project.initialTemplate', [
    'pipeline',
    'agent',
  ])
  if (project.interfaceUnmanaged !== undefined) requireBoolean(project.interfaceUnmanaged, 'project.interfaceUnmanaged')
  if (project.github !== undefined) validateGithubUrl(requireString(project.github, 'project.github'))
}

function validateFeatures(features: Record<string, unknown>): void {
  for (const name of [
    'ci',
    'release',
    'vscode',
    'quality',
  ]) {
    const feature = requireRecord(features[name], `features.${name}`)
    requireBoolean(feature.enabled, `features.${name}.enabled`)
  }
}

function validateController(controller: Record<string, unknown>): void {
  const kinds = requireArray(controller.kinds, 'controller.kinds')
  if (kinds.length === 0) invalid('controller.kinds', 'must include at least one controller')
  const seen = new Set<string>()
  for (let index = 0; index < kinds.length; index += 1) {
    const path = `controller.kinds[${index}]`
    const kind = requireChoice(kinds[index], path, CONTROLLER_KINDS)
    if (seen.has(kind)) invalid(path, `duplicates controller ${JSON.stringify(kind)}`)
    seen.add(kind)
  }
}

function validateResources(resources: unknown[]): void {
  const slugs = new Set<string>()
  const paths = new Set<string>()
  for (let index = 0; index < resources.length; index += 1) {
    const base = `resources[${index}]`
    const resource = requireRecord(resources[index], base)
    const slug = requireString(resource.slug, `${base}.slug`)
    if (!/^[a-z0-9](?:[a-z0-9-]{0,212}[a-z0-9])?$/.test(slug)) {
      invalid(`${base}.slug`, 'must use lowercase ASCII letters, numbers, and hyphens')
    }
    if (slugs.has(slug)) invalid(`${base}.slug`, `duplicates resource slug ${JSON.stringify(slug)}`)
    slugs.add(slug)

    requireNonBlank(resource.label, `${base}.label`)
    const resourcePath = requireSafeRelativePath(resource.path, `${base}.path`)
    const portablePath = resourcePath.toLowerCase()
    if (paths.has(portablePath)) invalid(`${base}.path`, `duplicates resource path ${JSON.stringify(resourcePath)}`)
    paths.add(portablePath)
    requireBoolean(resource.enabled, `${base}.enabled`)
  }
}

function validateReleaseSelector(
  selector: Record<string, unknown>,
  path: string,
  requireCurrentChannel: boolean,
): void {
  const channel = requireNonBlank(selector.channel, `${path}.channel`)
  if (requireCurrentChannel && !RELEASE_CHANNELS.includes(channel as (typeof RELEASE_CHANNELS)[number])) {
    invalid(`${path}.channel`, `must be one of: ${RELEASE_CHANNELS.join(', ')}`)
  }
  if (selector.version !== undefined) requireString(selector.version, `${path}.version`)
}

function validateRuntimeSelector(
  selector: Record<string, unknown>,
  path: string,
  requireCurrentChannel: boolean,
): void {
  validateReleaseSelector(selector, path, requireCurrentChannel)
  requireBoolean(selector.enabled, `${path}.enabled`)
}

function validateOcr(ocr: Record<string, unknown>): void {
  const source = requireChoice(ocr.source, 'ocr.source', [
    'download',
    'submodule',
  ])
  if (source === 'submodule' && ocr.submodulePath === undefined) {
    invalid('ocr.submodulePath', 'is required when ocr.source is "submodule"')
  }
  if (ocr.submodulePath !== undefined) requireSafeRelativePath(ocr.submodulePath, 'ocr.submodulePath')
  if (ocr.files === undefined) return

  const files = requireRecord(ocr.files, 'ocr.files')
  for (const [destination, sourcePath] of Object.entries(files)) {
    requireSafeRelativePath(destination, `ocr.files[${JSON.stringify(destination)}] destination`, false)
    requireSafeRelativePath(sourcePath, `ocr.files[${JSON.stringify(destination)}]`)
  }
}

function validatePython(python: Record<string, unknown>): void {
  requireNonBlank(python.requiresPython, 'python.requiresPython')
  requireNonBlank(python.recommendedPython, 'python.recommendedPython')
  if (python.devCommand === undefined) return
  const command = requireArray(python.devCommand, 'python.devCommand')
  if (command.length === 0) invalid('python.devCommand', 'must include at least one command argument')
  for (let index = 0; index < command.length; index += 1) {
    requireNonBlank(command[index], `python.devCommand[${index}]`)
  }
}

function validateGithubUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalid('project.github', 'must be an HTTPS GitHub repository URL')
  }
  const pathParts = url.pathname.split('/').filter(Boolean)
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    pathParts.length !== 2 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    pathParts.some((part) => part === '.' || part === '..')
  ) {
    invalid('project.github', 'must be an HTTPS GitHub repository URL')
  }
}

function requireSafeRelativePath(value: unknown, path: string, allowNested = true): string {
  const stringValue = requireString(value, path)
  const segments = stringValue.split('/')
  if (
    stringValue.trim() !== stringValue ||
    stringValue === '' ||
    stringValue.includes('\\') ||
    stringValue.startsWith('/') ||
    /^[A-Za-z]:/.test(stringValue) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    (!allowNested && segments.length !== 1)
  ) {
    const expectation = allowNested ? 'a project-relative path' : 'a single file name'
    invalid(path, `must be ${expectation} without absolute, empty, dot, or backslash segments`)
  }
  return stringValue
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path || 'root', 'must be an object')
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, 'must be an array')
  return value
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid(path, 'must be a string')
  return value
}

function requireNonBlank(value: unknown, path: string): string {
  const stringValue = requireString(value, path)
  if (stringValue.trim() === '') invalid(path, 'must not be blank')
  return stringValue
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean')
  return value
}

function requireChoice<const T extends string>(value: unknown, path: string, choices: readonly T[]): T {
  const stringValue = requireString(value, path)
  if (!choices.includes(stringValue as T)) invalid(path, `must be one of: ${choices.join(', ')}`)
  return stringValue as T
}

function invalid(path: string, message: string): never {
  throw new Error(`Invalid maa-project.json: ${path} ${message}.`)
}
