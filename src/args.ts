import type { CliOptions, ControllerKind, LicenseKind, NetworkMode, TemplateName } from './types.js'
import { controllerUnavailableMessage, normalizeControllerKind, uniqueControllerKinds } from './controllers.js'
import { parseCliLanguage } from './lang.js'
import { UPDATE_TARGETS } from './update-targets.js'

type CommandMode =
  | 'create'
  | '--help'
  | '--cli-version'
  | '--doctor'
  | '--sync'
  | '--update'
  | '--add'
  | '--list-backups'
  | '--show-backup'
  | '--restore'
  | '--clean-cache'
  | '--mcp'

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    cliVersion: false,
    template: 'pipeline',
    add: [],
    update: [],
    doctor: false,
    yes: false,
    noInteractive: false,
    force: false,
    clearStaleLock: false,
    allowNonGitDir: false,
    allowPendingCommit: false,
    skipDownload: false,
    verbose: false,
    noColor: false,
    assist: false,
    dryRun: false,
    listBackups: false,
    cleanCache: false,
    report: false,
    mcp: false,
    explicitTemplate: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true
        break
      case '--cli-version':
      case '-V':
        options.cliVersion = true
        break
      case '--template':
        options.template = readValue(argv, ++index, arg) as TemplateName
        options.explicitTemplate = true
        break
      case '--add':
        options.add.push(readValue(argv, ++index, arg))
        if (options.add.at(-1) === 'resource-pack') {
          const next = argv[index + 1]
          if (next && !next.startsWith('-')) {
            options.resourcePackSlug = next
            index += 1
          }
        }
        break
      case '--update':
        options.update.push(readValue(argv, ++index, arg))
        break
      case '--sync':
        options.sync = readValue(argv, ++index, arg)
        {
          const next = argv[index + 1]
          if (next && !next.startsWith('-')) {
            options.syncValue = next
            index += 1
          }
        }
        break
      case '--doctor':
        options.doctor = true
        break
      case '--report':
        options.report = true
        break
      case '--mcp':
        options.mcp = true
        break
      case '--yes':
        options.yes = true
        options.noInteractive = true
        break
      case '--no-interactive':
        options.noInteractive = true
        break
      case '--force':
        options.force = true
        break
      case '--clear-stale-lock':
        options.clearStaleLock = true
        break
      case '--allow-non-git-dir':
        options.allowNonGitDir = true
        break
      case '--allow-pending-commit':
        options.allowPendingCommit = true
        break
      case '--skip-download':
        options.skipDownload = true
        break
      case '--verbose':
        options.verbose = true
        break
      case '--no-color':
        options.noColor = true
        break
      case '--lang':
        options.lang = parseCliLanguage(readValue(argv, ++index, arg), arg)
        break
      case '--git':
        options.initializeGit = true
        break
      case '--no-git':
        options.initializeGit = false
        break
      case '--assist':
        options.assist = true
        break
      case '--from':
        options.from = readValue(argv, ++index, arg)
        break
      case '--migrate':
        options.migrate = readValue(argv, ++index, arg)
        break
      case '--target':
        options.target = readValue(argv, ++index, arg)
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--network':
        options.network = readValue(argv, ++index, arg) as NetworkMode
        break
      case '--label':
        options.label = readValue(argv, ++index, arg)
        break
      case '--name':
        options.displayName = readValue(argv, ++index, arg)
        break
      case '--slug':
        options.slug = readValue(argv, ++index, arg)
        break
      case '--version':
        options.version = readValue(argv, ++index, arg)
        break
      case '--license':
        options.license = readValue(argv, ++index, arg) as LicenseKind
        break
      case '--controller':
        options.controllers = uniqueControllerKinds([
          ...(options.controllers ?? []),
          ...parseControllerOption(readValue(argv, ++index, arg)),
        ])
        break
      case '--restore':
        options.restore = readValue(argv, ++index, arg)
        break
      case '--list-backups':
        options.listBackups = true
        break
      case '--show-backup':
        options.showBackup = readValue(argv, ++index, arg)
        break
      case '--clean-cache':
        options.cleanCache = true
        break
      case '--log-file':
        options.logFile = readValue(argv, ++index, arg)
        break
      default:
        if (arg.startsWith('-')) {
          throw new Error(`Unknown option: ${arg}`)
        }
        if (options.name) {
          throw new Error(`Unexpected argument: ${arg}`)
        }
        options.name = arg
    }
  }

  validateEnum(
    options.template,
    [
      'pipeline',
      'agent',
    ],
    '--template',
  )
  if (options.network)
    validateEnum(
      options.network,
      [
        'auto',
        'official',
      ],
      '--network',
    )
  if (options.license) {
    validateEnum(
      options.license,
      [
        'AGPL-3.0-or-later',
        'MIT',
        'None',
      ],
      '--license',
    )
  }
  return options
}

export function validateCommandModes(options: CliOptions): void {
  const modes: CommandMode[] = []

  if (options.name !== undefined) modes.push('create')
  if (options.help) modes.push('--help')
  if (options.cliVersion) modes.push('--cli-version')
  if (options.doctor) modes.push('--doctor')
  if (options.sync !== undefined) modes.push('--sync')
  if (options.update.length > 0) modes.push('--update')
  if (options.add.length > 0 && options.name === undefined) modes.push('--add')
  if (options.listBackups) modes.push('--list-backups')
  if (options.showBackup !== undefined) modes.push('--show-backup')
  if (options.restore !== undefined) modes.push('--restore')
  if (options.cleanCache) modes.push('--clean-cache')
  if (options.mcp) modes.push('--mcp')

  if (modes.length > 1) {
    throw new Error(`Command modes are mutually exclusive; choose only one: ${modes.join(', ')}`)
  }
  if (options.dryRun && options.restore === undefined && options.migrate === undefined) {
    throw new Error('--dry-run requires --restore <backup-id>.')
  }
  validateOptionApplicability(options, modes[0] ?? 'create')
}

export function applyCliEnvironment(
  options: Pick<CliOptions, 'noColor'>,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (!options.noColor) return
  environment.NO_COLOR = '1'
  environment.FORCE_COLOR = '0'
}

function validateOptionApplicability(options: CliOptions, mode: CommandMode): void {
  const creationOptions: Array<readonly [option: string, provided: boolean]> = [
    ['--template', options.explicitTemplate],
    ['--slug', options.slug !== undefined],
    ['--controller', options.controllers !== undefined],
    ['--git/--no-git', options.initializeGit !== undefined],
    ['--force', options.force],
    ['--allow-non-git-dir', options.allowNonGitDir],
    ['--allow-pending-commit', options.allowPendingCommit],
    ['--skip-download', options.skipDownload],
    ['--yes/--no-interactive', options.noInteractive],
    ['--lang', options.lang !== undefined],
  ]
  for (const [option, provided] of creationOptions) {
    assertOptionAllowed(mode, option, provided, ['create'])
  }
  assertOptionAllowed(mode, '--report', options.report, [
    'create',
    '--doctor',
    '--sync',
    '--update',
    '--add',
    '--list-backups',
    '--show-backup',
    '--restore',
    '--clean-cache',
  ])
  assertOptionAllowed(mode, '--log-file', options.logFile !== undefined, [
    'create',
    '--doctor',
    '--sync',
    '--update',
    '--add',
    '--list-backups',
    '--show-backup',
    '--restore',
    '--clean-cache',
  ])
  assertOptionAllowed(mode, '--clear-stale-lock', options.clearStaleLock, [
    'create',
    '--sync',
    '--update',
    '--add',
    '--list-backups',
    '--show-backup',
    '--restore',
  ])
  for (const [option, provided] of [
    ['--verbose', options.verbose],
    ['--no-color', options.noColor],
  ] as const) {
    assertOptionAllowed(mode, option, provided, [
      'create',
      '--doctor',
      '--sync',
      '--update',
      '--add',
      '--list-backups',
      '--show-backup',
      '--restore',
      '--clean-cache',
    ])
  }

  validateSyncAlias(options.displayName !== undefined, mode, options.sync, '--name', 'display-name')
  validateSyncAlias(options.version !== undefined, mode, options.sync, '--version', 'version')
  validateSyncAlias(options.license !== undefined, mode, options.sync, '--license', 'license')
  validateSyncAlias(options.network !== undefined, mode, options.sync, '--network', 'network')
  validateSyncValueSource(options, mode)

  if (
    options.label !== undefined &&
    !((mode === 'create' || mode === '--add') && options.add.includes('resource-pack'))
  ) {
    throw new Error('--label is only valid when adding a resource-pack.')
  }
}

function validateSyncValueSource(options: CliOptions, mode: CommandMode): void {
  if (mode !== '--sync' || options.syncValue === undefined) return
  let explicitOption: '--name' | '--version' | '--license' | '--network' | undefined
  if (options.sync === 'display-name' && options.displayName !== undefined) explicitOption = '--name'
  if (options.sync === 'version' && options.version !== undefined) explicitOption = '--version'
  if (options.sync === 'license' && options.license !== undefined) explicitOption = '--license'
  if (options.sync === 'network' && options.network !== undefined) explicitOption = '--network'
  if (!explicitOption) return
  throw new Error(
    `--sync ${options.sync} accepts one value source; use either its positional value or ${explicitOption}.`,
  )
}

function validateSyncAlias(
  provided: boolean,
  mode: CommandMode,
  syncTarget: string | undefined,
  option: '--name' | '--version' | '--license' | '--network',
  target: string,
): void {
  if (!provided || mode === 'create' || (mode === '--sync' && syncTarget === target)) return
  throw new Error(`${option} is only valid with project creation or --sync ${target}.`)
}

function assertOptionAllowed(
  mode: CommandMode,
  option: string,
  provided: boolean,
  allowedModes: readonly CommandMode[],
): void {
  if (!provided || allowedModes.includes(mode)) return
  throw new Error(`${option} is not valid with ${mode}.`)
}

export function formatCliHelp(version: string): string {
  return `create-maa-project ${version}
Create and maintain MaaFW application projects.

Usage:
  create-maa-project [project] [creation options]
  create-maa-project --add <addon> [add-on options]
  create-maa-project --sync <target> [value]
  create-maa-project --update <target>
  create-maa-project --doctor [--report]
  create-maa-project --list-backups [--report]
  create-maa-project --show-backup <backup-id> [--report]
  create-maa-project --restore <backup-id> [--dry-run] [--report]
  create-maa-project --clean-cache
  create-maa-project --mcp

Creation options:
  --template <pipeline|agent>       Select the initial template.
  --slug <project-id>               Set the ASCII project identifier.
  --name <display-name>             Set the human-readable project name.
  --controller <kind[,kind...]>     Select MaaFW controllers.
  --license <AGPL-3.0-or-later|MIT|None>
                                    Set the project license.
  --network <auto|official>         Select the asset network mode.
  --add <addon>                     Include an add-on during creation.
  --git | --no-git                  Enable or disable Git initialization.
  --force                           Permit creation in an existing target.
  --allow-non-git-dir               Permit a forced non-Git target directory.
  --allow-pending-commit            Permit an initial commit with pending work.
  --skip-download                   Defer dependency and asset downloads.
  --yes                             Accept defaults without prompting.
  --no-interactive                  Disable interactive creation prompts.

Maintenance modes:
  --add <addon>                     Add a capability to the current project.
    Add-ons: dev-tools, github, agent, resource-pack, git-cliff, auto-format,
             optimize-images, community, dependabot, schema-sync
  --label <name>                    Label a resource-pack add-on.
  --sync <target> [value]           Sync metadata into generated files.
    Targets: config, metadata, display-name, version, license, github-url, network
  --update <target>                 Update schemas, assets, or dependencies.
    Targets: ${UPDATE_TARGETS.join(', ')}
  --doctor                          Diagnose the current project.
  --list-backups                    List managed-files backups newest first.
  --show-backup <backup-id>         Show paths and actions in one backup.
  --restore <backup-id>             Restore managed files; .git is excluded.
  --dry-run                         Preview --restore without changing files.
  --clean-cache                     Remove the local download cache.
  --mcp                             Start the MCP server over stdio.

Common options:
  --report                          Emit a machine-readable JSON result.
  --clear-stale-lock                Clear a stale project write lock.
  --verbose                         Record and print invocation diagnostics.
  --no-color                        Disable color in this process and child tools.
  --lang <auto|en|zh-CN>            Select the prompt language.
  --log-file <path>                 Write logs to a specific file.
  -h, --help                        Show this help and exit.
  -V, --cli-version                 Print the CLI version and exit.

Project version:
  --version <semver>                Set the project version; this is not the CLI version.

Examples:
  create-maa-project my-project --template agent --license MIT
  create-maa-project --add resource-pack extra --label "Extra Resource"
  create-maa-project --sync version --version 0.2.0
  create-maa-project --update ocr-models
  create-maa-project --doctor --report
  create-maa-project --list-backups
  create-maa-project --restore <backup-id> --dry-run`
}

function parseControllerOption(value: string): ControllerKind[] {
  const kinds: ControllerKind[] = []
  for (const item of value.split(',')) {
    const kind = normalizeControllerKind(item)
    if (!kind) throw new Error(controllerUnavailableMessage(item.trim() || value))
    kinds.push(kind)
  }
  return kinds
}

function readValue(argv: string[], index: number, option: string): string {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}`)
  }
  return value
}

function validateEnum(value: string, allowed: string[], option: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${option} must be one of: ${allowed.join(', ')}`)
  }
}
