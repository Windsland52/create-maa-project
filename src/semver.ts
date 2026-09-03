export function isValidSemVer(version: string): boolean {
  const buildSeparator = version.indexOf('+')
  if (buildSeparator >= 0 && version.indexOf('+', buildSeparator + 1) >= 0) return false

  const versionAndPrerelease = buildSeparator >= 0 ? version.slice(0, buildSeparator) : version
  const build = buildSeparator >= 0 ? version.slice(buildSeparator + 1) : undefined
  if (build !== undefined && !areValidIdentifiers(build, false)) return false

  const prereleaseSeparator = versionAndPrerelease.indexOf('-')
  const core = prereleaseSeparator >= 0 ? versionAndPrerelease.slice(0, prereleaseSeparator) : versionAndPrerelease
  const prerelease = prereleaseSeparator >= 0 ? versionAndPrerelease.slice(prereleaseSeparator + 1) : undefined

  const coreIdentifiers = core.split('.')
  if (coreIdentifiers.length !== 3 || !coreIdentifiers.every(isValidCoreIdentifier)) return false
  return prerelease === undefined || areValidIdentifiers(prerelease, true)
}

export function assertValidSemVer(version: string): void {
  if (!isValidSemVer(version)) {
    throw new Error(`Invalid version "${version}". Use a SemVer version such as 0.1.0.`)
  }
}

function isValidCoreIdentifier(identifier: string): boolean {
  return isNumericIdentifier(identifier) && !hasLeadingZero(identifier)
}

function areValidIdentifiers(value: string, rejectNumericLeadingZeros: boolean): boolean {
  const identifiers = value.split('.')
  return identifiers.every(
    (identifier) =>
      isValidIdentifier(identifier) &&
      !(rejectNumericLeadingZeros && isNumericIdentifier(identifier) && hasLeadingZero(identifier)),
  )
}

function isValidIdentifier(identifier: string): boolean {
  if (identifier.length === 0) return false
  for (const character of identifier) {
    const code = character.charCodeAt(0)
    const isDigit = code >= 48 && code <= 57
    const isUppercaseLetter = code >= 65 && code <= 90
    const isLowercaseLetter = code >= 97 && code <= 122
    if (!isDigit && !isUppercaseLetter && !isLowercaseLetter && character !== '-') return false
  }
  return true
}

function isNumericIdentifier(identifier: string): boolean {
  if (identifier.length === 0) return false
  for (const character of identifier) {
    const code = character.charCodeAt(0)
    if (code < 48 || code > 57) return false
  }
  return true
}

function hasLeadingZero(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith('0')
}

export type ParsedSemVer = {
  major: number
  minor: number
  patch: number
  prerelease?: string
  build?: string
}

export function parseSemVer(version: string): ParsedSemVer | undefined {
  if (!isValidSemVer(version)) return undefined
  const buildSeparator = version.indexOf('+')
  const versionAndPrerelease = buildSeparator >= 0 ? version.slice(0, buildSeparator) : version
  const build = buildSeparator >= 0 ? version.slice(buildSeparator + 1) : undefined

  const prereleaseSeparator = versionAndPrerelease.indexOf('-')
  const core = prereleaseSeparator >= 0 ? versionAndPrerelease.slice(0, prereleaseSeparator) : versionAndPrerelease
  const prerelease = prereleaseSeparator >= 0 ? versionAndPrerelease.slice(prereleaseSeparator + 1) : undefined

  const [majorStr, minorStr, patchStr] = core.split('.')
  return {
    major: Number(majorStr),
    minor: Number(minorStr),
    patch: Number(patchStr),
    ...(prerelease !== undefined ? { prerelease } : {}),
    ...(build !== undefined ? { build } : {}),
  }
}

export function isStableSemVer(version: unknown): version is string {
  if (typeof version !== 'string') return false
  const parsed = parseSemVer(version)
  return parsed !== undefined && parsed.prerelease === undefined
}

export function isSemVerGreaterThan(candidate: string, baseline: string): boolean {
  const candidateParsed = parseSemVer(candidate)
  const baselineParsed = parseSemVer(baseline)
  if (!candidateParsed || !baselineParsed) return false
  if (candidateParsed.major !== baselineParsed.major) {
    return candidateParsed.major > baselineParsed.major
  }
  if (candidateParsed.minor !== baselineParsed.minor) {
    return candidateParsed.minor > baselineParsed.minor
  }
  return candidateParsed.patch > baselineParsed.patch
}
