// Keep pnpm-workspace.yaml `overrides` ahead of security advisories.
//
// Runs `pnpm audit`, upserts every flagged package into `overrides` with its minimal patched
// version (mirroring the existing exact-pin convention), reinstalls, and re-audits until clean.
// Exits non-zero only when some finding has no available patch - that case genuinely needs a human
// decision.
//
// Driven by `.github/workflows/deps-audit.yml`; run it by hand with `pnpm audit:deps`.

import { spawnSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const WORKSPACE_FILE = join(repoRoot, 'pnpm-workspace.yaml')
const AUDIT_LEVEL = 'low'
const MAX_ROUNDS = 3

interface AuditFinding {
  name: string
  patched: string
  severity: string
  url: string | undefined
  vulnerable: string | undefined
}

interface AuditAdvisory {
  module_name?: string
  patched_versions?: string
  severity?: string
  url?: string
  vulnerable_versions?: string
}

interface AuditVulnerability {
  severity?: string
  range?: string
  fixAvailable?: { name?: string; version?: string } | boolean
}

interface AuditDocument {
  advisories?: Record<string, AuditAdvisory>
  vulnerabilities?: Record<string, AuditVulnerability>
}

if (isMainModule()) {
  main()
}

function main(): void {
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const findings = collectFindings()
    if (findings.length === 0) {
      console.log(
        round === 1 ? `No known vulnerabilities at level "${AUDIT_LEVEL}". Nothing to do.` : 'Audit is now clean.',
      )
      return
    }

    console.log(`Round ${round}: ${findings.length} advisory package(s):`)
    const updated: string[] = []
    for (const finding of findings) {
      const bumped = upsertOverride(finding.name, finding.patched)
      console.log(`  ${finding.name} -> ${finding.patched} (${finding.severity}, ${finding.url ?? 'no advisory url'})`)
      if (bumped) updated.push(`${finding.name}@${finding.patched}`)
    }

    if (updated.length === 0) {
      // Nothing changed although findings exist: pinned versions are already at/above every
      // reported patch, yet audit still complains. Likely a lockfile drift - reinstall once, then
      // give up if it persists.
      reinstall()
      continue
    }

    reinstall()
  }

  const remaining = collectFindings()
  if (remaining.length > 0) {
    console.error(`Still vulnerable after ${MAX_ROUNDS} rounds (missing upstream patches?):`)
    for (const finding of remaining) {
      console.error(`  ${finding.name} ${finding.vulnerable} (${finding.severity})`)
    }
    process.exit(1)
  }
  console.log('Audit is now clean.')
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

function reinstall(): void {
  resetWorkspaceState()
  // CI implies pnpm's frozen-lockfile default; the whole job exists to update the lockfile.
  run('pnpm', ['install', '--no-frozen-lockfile'])
}

function resetWorkspaceState(): void {
  // pnpm's optimisticRepeatInstall shortcut trusts node_modules/.pnpm-workspace-state-v1.json and
  // skips re-resolution without noticing a freshly added overrides block (pnpm 11.5.x), so drop
  // the state to force the install to actually resolve.
  try {
    unlinkSync(join(repoRoot, 'node_modules', '.pnpm-workspace-state-v1.json'))
  } catch {
    // No state file - nothing to reset.
  }
}

function auditJson(): AuditDocument | null {
  // `pnpm audit` exits non-zero whenever findings exist, so capture instead of inheriting.
  const result = spawnSync('pnpm', ['audit', '--json', '--audit-level', AUDIT_LEVEL], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  const text = (result.stdout ?? '').trim()
  if (!text) return null
  try {
    return JSON.parse(text) as AuditDocument
  } catch {
    return null
  }
}

function collectFindings(): AuditFinding[] {
  const data = auditJson()
  if (!data) return []

  const byName = new Map<string, AuditFinding>()
  const consider = (
    name: string | undefined,
    patchedText: string | undefined,
    severity: string | undefined,
    url: string | undefined,
    vulnerable: string | undefined,
  ): void => {
    const patched = parseFloorVersion(patchedText)
    if (!name || !patched) return
    const previous = byName.get(name)
    if (!previous || compareVersions(patched, previous.patched) > 0) {
      byName.set(name, { name, patched, severity: severity ?? '', url, vulnerable })
    }
  }

  // npm-classic shape: advisories keyed by id.
  for (const advisory of Object.values(data.advisories ?? {})) {
    consider(
      advisory.module_name,
      advisory.patched_versions,
      advisory.severity,
      advisory.url,
      advisory.vulnerable_versions,
    )
  }
  // npm-modern shape: vulnerabilities with fixAvailable objects.
  for (const entry of Object.values(data.vulnerabilities ?? {})) {
    const fix = entry.fixAvailable
    if (fix && typeof fix === 'object' && fix.name && fix.version) {
      consider(fix.name, fix.version, entry.severity, undefined, entry.range)
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** ">=3.3.18" | "=1.2.3" | "^4.5.6 || ^5.0.0" -> lowest concrete x.y.z mentioned. */
function parseFloorVersion(text: string | undefined): string | null {
  if (typeof text !== 'string') return null
  const match = text.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
  return match ? match[0] : null
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if ((pa[index] ?? 0) !== (pb[index] ?? 0)) return (pa[index] ?? 0) - (pb[index] ?? 0)
  }
  return 0
}

function upsertOverride(name: string, version: string): boolean {
  const original = readFileSync(WORKSPACE_FILE, 'utf8')
  const updated = upsertOverrideContent(original, name, version)
  if (updated === original) return false
  writeFileSync(WORKSPACE_FILE, updated)
  return true
}

/** Insert or bump `name: version` inside the top-level `overrides:` block of a workspace file. */
export function upsertOverrideContent(content: string, name: string, version: string): string {
  const endsWithNewline = content.endsWith('\n')
  const lines = (endsWithNewline ? content.slice(0, -1) : content).split('\n')

  let start = lines.findIndex((line) => /^overrides:\s*$/.test(line))
  if (start === -1) {
    // No overrides block yet. Append one at the end of the document: splicing it in after another
    // block's key line would re-parent that block's indented children, which once turned
    // allowBuilds' `esbuild: false` into a boolean overrides.esbuild that pnpm install rejects.
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()
    if (lines.length > 0) lines.push('')
    lines.push('overrides:')
    start = lines.length - 1
  }

  let end = start + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line === undefined || line.trim() === '' || !/^\s/.test(line)) break
    end++
  }

  const keyPattern = `^ {2}(?<quote>"?)${escapeRegExp(name)}\\k<quote>: `
  const existing = lines.slice(start + 1, end).findIndex((line) => new RegExp(keyPattern).test(line))
  const renderedKey = renderKey(name)

  if (existing !== -1) {
    lines[start + 1 + existing] = `  ${renderedKey}: ${version}`
  } else {
    const entry = `  ${renderedKey}: ${version}`
    let insertAt = start + 1
    while (insertAt < end && compareKeys(sortKeyOf(lines[insertAt]), sortKeyOf(entry)) <= 0) {
      insertAt++
    }
    lines.splice(insertAt, 0, entry)
  }

  return `${lines.join('\n')}\n`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderKey(name: string): string {
  // Plain scalars must not start with YAML reserved indicators such as "@".
  return name.startsWith('@') ? `"${name}"` : name
}

function sortKeyOf(line: string | undefined): string {
  const match = line?.match(/^ {2}"?([^":]+)"?: /)
  return match?.[1]?.toLowerCase() ?? '\uffff'
}

function compareKeys(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}
