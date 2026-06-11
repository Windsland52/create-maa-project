import type { CliOptions, ControllerKind, LicenseKind, NetworkMode, TemplateName } from './types.js'

export function parseArgs(argv: string[]): CliOptions {
    const options: CliOptions = {
        template: 'pipeline',
        add: [],
        update: [],
        doctor: false,
        diff: false,
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
        acceptChanges: [],
        acceptChangesRequested: false,
        cleanCache: false,
        report: false,
        explicitTemplate: false
    }

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]
        if (!arg) continue
        switch (arg) {
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
            case '--diff':
                options.diff = true
                break
            case '--yes':
                options.yes = true
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
                options.controller = readValue(argv, ++index, arg) as ControllerKind
                break
            case '--accept-changes':
                options.acceptChangesRequested = true
                for (;;) {
                    const next = argv[index + 1]
                    if (!next || next.startsWith('-')) break
                    options.acceptChanges.push(next)
                    index += 1
                }
                break
            case '--restore':
                options.restore = readValue(argv, ++index, arg)
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

    validateEnum(options.template, ['pipeline', 'agent'], '--template')
    if (options.add.length > 0) {
        throw new Error('--add is not supported in the pure pipeline scaffold.')
    }
    if (options.network) validateEnum(options.network, ['auto', 'official'], '--network')
    if (options.license) {
        validateEnum(options.license, ['AGPL-3.0-or-later', 'MIT', 'None'], '--license')
    }
    if (options.controller) validateEnum(options.controller, ['ADB', 'Win32', 'None'], '--controller')

    return options
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
