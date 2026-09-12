// Keep the npm versions pinned into generated projects current, without hand-editing templates.
//
// `src/template-deps.json` is the single source of truth for the `devDependencies` and the pnpm pin
// that `templates/addons/dev-tools/package.json` renders. This script resolves both from the npm
// registry, rewrites that file, mirrors the shared toolchain packages into this repository's own
// `package.json` (the CLI formats its templates with the same Prettier, so the two must agree), and
// refreshes the lockfile.
//
// Only same-major moves are automatic. A toolchain major can change generated output, and a pnpm
// major can raise the Node floor declared in `src/node-support.ts`, so both are reported and skipped
// unless `--major` is passed. A same-major pnpm bump is also held when its published `engines.node`
// would outgrow that floor — best-effort only, because pnpm does not state its real requirement in
// that field, which is why CI runs the suite on the floor as the backstop.
//
// Driven by `.github/workflows/deps-sync.yml`; run it by hand with `pnpm sync:deps`.

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SUPPORTED_NODE_RANGE } from '../src/node-support.js'
import { isSemVerGreaterThan, isValidSemVer, parseSemVer } from '../src/semver.js'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const TEMPLATE_DEPS_FILE = join(repoRoot, 'src/template-deps.json')
const REPO_PACKAGE_FILE = join(repoRoot, 'package.json')
const REGISTRY_URL = 'https://registry.npmjs.org'
const REQUEST_TIMEOUT_MS = 30_000

/** What the npm registry returns for `/<name>/latest`. */
export type LatestManifest = {
  version?: unknown
  engines?: {
    node?: unknown
  }
}

export type TemplateDeps = {
  devDependencies: Record<string, string>
  pnpm: string
}

export type PinPlan = {
  name: string
  current: string
  latest: string
  /** `update` moves the pin, `hold-major` waits for a human, `current` is already newest. */
  action: 'update' | 'hold-major' | 'current'
  /** Why a newer candidate was rejected. */
  note?: string
}

type Options = {
  check: boolean
  dryRun: boolean
  major: boolean
  install: boolean
  only: string[]
}

const USAGE = `Usage: pnpm sync:deps [options]

  --check        exit 1 when a pin is behind the newest allowed version (writes nothing)
  --dry-run      print the plan and write nothing
  --major        allow major-version updates (default: hold them for a human)
  --only <name>  limit the run to one pin; repeatable
  --no-install   rewrite pins only; skip "pnpm install" and "pnpm format"`

if (isMainModule()) {
  await main()
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const deps = readTemplateDeps()
  const names = [
    ...Object.keys(deps.devDependencies),
    'pnpm',
  ].sort()
  const selected = options.only.length > 0 ? options.only : names
  for (const name of selected) {
    if (!names.includes(name)) fail(`Unknown pin "${name}". Known pins: ${names.join(', ')}.`)
  }

  const plans: PinPlan[] = []
  for (const name of selected) {
    const current = name === 'pnpm' ? deps.pnpm : requiredVersion(deps, name)
    const manifest = await fetchLatest(name)
    const latest = manifest.version
    if (typeof latest !== 'string' || !isValidSemVer(latest)) {
      fail(`${REGISTRY_URL}/${name}/latest did not report a plain SemVer version.`)
    }
    plans.push(
      planPin({
        name,
        current,
        latest,
        allowMajor: options.major,
        manifest,
      }),
    )
  }

  report(plans)
  const pending = plans.filter((plan) => plan.action === 'update')
  if (options.check) {
    if (pending.length > 0)
      fail(`${pending.length} pin(s) are behind the newest allowed version. Run "pnpm sync:deps".`)
    console.log('Every pin is at the newest allowed version.')
    return
  }
  if (pending.length === 0) {
    console.log('Nothing to update.')
    return
  }
  if (options.dryRun) {
    console.log(`Dry run: ${pending.length} pin(s) would be updated.`)
    return
  }

  const next = applyPins(deps, pending)
  writeTemplateDeps(next)
  const repoChanged = syncRepoPackage(next, pending)
  console.log(`Updated ${pending.length} pin(s) in src/template-deps.json${repoChanged ? ' and package.json' : ''}.`)

  if (!options.install) return
  run('pnpm', [
    'install',
  ])
  // A Prettier or sort-plugin bump can reflow templates, so land the formatter's own consequences
  // in the same change instead of leaving `pnpm check` red for the workflow.
  run('pnpm', [
    'format',
  ])
}

/**
 * Decide one pin. Pure so the policy stays testable: a newer candidate only moves a pin when it
 * stays inside the current major (or `--major` was passed), and a pnpm candidate is additionally
 * held when its published `engines.node` asks for a newer Node than this project and every generated
 * project declare. That second check is best-effort: pnpm does not express its real requirement
 * (`node:sqlite` and friends) in the published `engines` field.
 */
export function planPin(input: {
  name: string
  current: string
  latest: string
  allowMajor: boolean
  manifest?: LatestManifest
}): PinPlan {
  const { name, current, latest, allowMajor } = input
  if (!isSemVerGreaterThan(latest, current)) {
    return {
      name,
      current,
      latest,
      action: 'current',
    }
  }
  const currentMajor = parseSemVer(current)?.major
  const latestMajor = parseSemVer(latest)?.major
  if (currentMajor !== latestMajor && !allowMajor) {
    return {
      name,
      current,
      latest,
      action: 'hold-major',
      note: `major ${String(latestMajor)} needs --major`,
    }
  }
  if (name === 'pnpm') {
    const required = minimumNodeVersion(input.manifest?.engines?.node)
    const floor = minimumNodeVersion(SUPPORTED_NODE_RANGE)
    if (required !== undefined && floor !== undefined && isSemVerGreaterThan(required, floor)) {
      return {
        name,
        current,
        latest,
        action: 'hold-major',
        note: `pnpm ${latest} needs Node >${required}; raise the floor in src/node-support.ts first`,
      }
    }
  }
  return {
    name,
    current,
    latest,
    action: 'update',
  }
}

/** Lowest concrete version an npm `engines.node` range admits, for `>=22.13.0 <23`, `^22.13`, ... */
export function minimumNodeVersion(range: unknown): string | undefined {
  if (typeof range !== 'string') return undefined
  // The optional prerelease/build group keeps `>=22.13.0-rc.1` from being read as 1.0.0, and it
  // leaves a hyphen range (`20.0.0 - 22.13.0`) intact because that hyphen is surrounded by spaces.
  const versions = Array.from(range.matchAll(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?/g), (match) =>
    [
      match[1] ?? '0',
      match[2] ?? '0',
      match[3] ?? '0',
    ].join('.'),
  )
  const [first, ...rest] = versions
  if (first === undefined) return undefined
  return rest.reduce((lowest, version) => (isSemVerGreaterThan(lowest, version) ? version : lowest), first)
}

function applyPins(deps: TemplateDeps, pending: PinPlan[]): TemplateDeps {
  const next: TemplateDeps = {
    devDependencies: {
      ...deps.devDependencies,
    },
    pnpm: deps.pnpm,
  }
  for (const plan of pending) {
    if (plan.name === 'pnpm') {
      next.pnpm = plan.latest
    } else {
      next.devDependencies[plan.name] = plan.latest
    }
  }
  return next
}

function report(plans: PinPlan[]): void {
  for (const plan of plans) {
    if (plan.action === 'update') {
      console.log(`  ${plan.name}: ${plan.current} -> ${plan.latest}`)
    } else if (plan.action === 'hold-major') {
      console.log(`  ${plan.name}: ${plan.current} (held: ${plan.note ?? 'major bump'})`)
    } else {
      console.log(`  ${plan.name}: ${plan.current} (current)`)
    }
  }
}

async function fetchLatest(name: string): Promise<LatestManifest> {
  const url = `${REGISTRY_URL}/${encodePackageName(name)}/latest`
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    fail(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) fail(`${url} responded ${String(response.status)} ${response.statusText}`)
  return (await response.json()) as LatestManifest
}

/** Scoped names go on the wire as `@scope%2Fname`. */
function encodePackageName(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
}

function requiredVersion(deps: TemplateDeps, name: string): string {
  const version = deps.devDependencies[name]
  if (version === undefined) fail(`src/template-deps.json has no devDependency "${name}".`)
  return version
}

function readTemplateDeps(): TemplateDeps {
  const parsed = JSON.parse(readFileSync(TEMPLATE_DEPS_FILE, 'utf8')) as Partial<TemplateDeps>
  if (parsed.devDependencies === undefined || typeof parsed.pnpm !== 'string') {
    fail(`${TEMPLATE_DEPS_FILE} must define devDependencies and pnpm.`)
  }
  for (const [
    name,
    version,
  ] of Object.entries(parsed.devDependencies)) {
    if (!isValidSemVer(version)) {
      fail(`${TEMPLATE_DEPS_FILE} pins ${name} to "${version}", which is not a plain SemVer version.`)
    }
  }
  return {
    devDependencies: parsed.devDependencies,
    pnpm: parsed.pnpm,
  }
}

function writeTemplateDeps(deps: TemplateDeps): void {
  const sorted: TemplateDeps = {
    devDependencies: Object.fromEntries(Object.entries(deps.devDependencies).sort(([a], [b]) => (a < b ? -1 : 1))),
    pnpm: deps.pnpm,
  }
  writeFileSync(TEMPLATE_DEPS_FILE, `${JSON.stringify(sorted, null, 4)}\n`, 'utf8')
}

/**
 * Mirror the shared pins into this repository's own `package.json`. Edited line by line rather than
 * re-serialised: that file is hand-sorted and Prettier-wrapped, so a full rewrite would churn parts
 * this script has no business touching.
 */
function syncRepoPackage(next: TemplateDeps, pending: PinPlan[]): boolean {
  const original = readFileSync(REPO_PACKAGE_FILE, 'utf8')
  let content = original
  for (const plan of pending) {
    if (plan.name === 'pnpm') continue
    content = replaceInDevDependencies(content, plan.name, plan.latest)
  }
  if (pending.some((plan) => plan.name === 'pnpm')) {
    content = content.replace(/^(\s*"packageManager":\s*)"pnpm@[^"]*"/m, `$1"pnpm@${next.pnpm}"`)
  }
  if (content === original) return false
  writeFileSync(REPO_PACKAGE_FILE, content, 'utf8')
  return true
}

/** A package that is template-only (such as `@nekosu/maa-tools`) is simply left alone. */
function replaceInDevDependencies(content: string, key: string, value: string): string {
  const block = objectRangeAfterKey(content, 'devDependencies')
  if (block === undefined) return content
  const slice = content.slice(block.start, block.end)
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const updated = slice.replace(new RegExp(`^(\\s*"${escaped}":\\s*)"[^"]*"`, 'm'), `$1"${value}"`)
  return updated === slice ? content : content.slice(0, block.start) + updated + content.slice(block.end)
}

/**
 * Brace range of the object value of a top-level JSON key, so an edit cannot reach another block.
 * Counts braces without a string-aware parser: correct for the flat `devDependencies` map this is
 * used on, and deliberately not a general-purpose JSON walker.
 */
function objectRangeAfterKey(content: string, key: string): { start: number; end: number } | undefined {
  const keyIndex = content.indexOf(`"${key}"`)
  if (keyIndex < 0) return undefined
  const open = content.indexOf('{', keyIndex)
  if (open < 0) return undefined
  let depth = 0
  for (let index = open; index < content.length; index += 1) {
    const character = content[index]
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) return { start: open, end: index + 1 }
    }
  }
  return undefined
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    check: false,
    dryRun: false,
    major: false,
    install: true,
    only: [],
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--check': {
        options.check = true
        break
      }
      case '--dry-run': {
        options.dryRun = true
        break
      }
      case '--major': {
        options.major = true
        break
      }
      case '--no-install': {
        options.install = false
        break
      }
      case '--only': {
        const name = argv[index + 1]
        if (name === undefined || name.startsWith('--')) fail('--only requires a package name.')
        options.only.push(name)
        index += 1
        break
      }
      case '--help':
      case '-h': {
        console.log(USAGE)
        process.exit(0)
        break
      }
      default: {
        fail(`Unknown option "${String(argument)}".\n\n${USAGE}`)
      }
    }
  }
  if (options.check && options.dryRun) fail('--check and --dry-run are mutually exclusive.')
  return options
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed with exit code ${String(result.status)}`)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href
}
