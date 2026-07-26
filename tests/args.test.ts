import { describe, expect, it } from 'vitest'
import { formatCliHelp, parseArgs, validateCommandModes } from '../src/args.js'

describe('parseArgs', () => {
  it('parses create options', () => {
    const options = parseArgs([
      '测试项目',
      '--name',
      '显示名',
      '--template',
      'agent',
      '--skip-download',
      '--slug',
      'arknights-helper',
      '--controller',
      'Win32',
    ])

    expect(options.name).toBe('测试项目')
    expect(options.displayName).toBe('显示名')
    expect(options.template).toBe('agent')
    expect(options.slug).toBe('arknights-helper')
    expect(options.skipDownload).toBe(true)
    expect(options.controllers).toEqual([
      'Win32',
    ])
  })

  it('parses multiple control targets', () => {
    const options = parseArgs([
      '--controller',
      'ADB,Win32',
      '--controller',
      'macos',
    ])

    expect(options.controllers).toEqual([
      'Adb',
      'Win32',
      'MacOS',
    ])
  })

  it('rejects unknown options', () => {
    expect(() =>
      parseArgs([
        '--bad',
      ]),
    ).toThrow('Unknown option')
  })

  it('parses resource pack folder after --add resource-pack', () => {
    const options = parseArgs([
      '--add',
      'resource-pack',
      'extra',
      '--label',
      '额外资源',
    ])

    expect(options.add).toEqual([
      'resource-pack',
    ])
    expect(options.resourcePackSlug).toBe('extra')
    expect(options.label).toBe('额外资源')
  })

  it('parses sync positional value', () => {
    const options = parseArgs([
      '--sync',
      'github-url',
      'https://github.com/MaaXYZ/MaaXX',
    ])

    expect(options.sync).toBe('github-url')
    expect(options.syncValue).toBe('https://github.com/MaaXYZ/MaaXX')
  })

  it('parses doctor report mode', () => {
    const options = parseArgs([
      '--doctor',
      '--report',
    ])

    expect(options.doctor).toBe(true)
    expect(options.report).toBe(true)
  })

  it('parses MCP server mode', () => {
    const options = parseArgs([
      '--mcp',
    ])

    expect(options.mcp).toBe(true)
  })

  it('parses help and CLI version aliases without changing project --version', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--cli-version']).cliVersion).toBe(true)
    expect(parseArgs(['-V']).cliVersion).toBe(true)
    expect(parseArgs(['--version', '1.2.3']).version).toBe('1.2.3')
  })

  it('parses interactive prompt language', () => {
    expect(
      parseArgs([
        '--lang',
        'zh',
      ]).lang,
    ).toBe('zh-CN')
    expect(
      parseArgs([
        '--lang',
        'en',
      ]).lang,
    ).toBe('en')
    expect(() =>
      parseArgs([
        '--lang',
        'fr',
      ]),
    ).toThrow('--lang must be one of: auto, en, zh-CN')
  })

  it('parses explicit git initialization choices', () => {
    expect(
      parseArgs([
        'my-project',
        '--git',
      ]).initializeGit,
    ).toBe(true)
    expect(
      parseArgs([
        'my-project',
        '--no-git',
      ]).initializeGit,
    ).toBe(false)
  })

  it('parses explicit stale lock cleanup', () => {
    expect(
      parseArgs([
        '--clear-stale-lock',
      ]).clearStaleLock,
    ).toBe(true)
  })

  it('makes --yes non-interactive while preserving its distinct intent', () => {
    expect(parseArgs(['my-project', '--yes'])).toMatchObject({
      name: 'my-project',
      yes: true,
      noInteractive: true,
    })
  })

  it('rejects removed managed-file options', () => {
    expect(() => parseArgs(['--diff'])).toThrow('Unknown option: --diff')
    expect(() => parseArgs(['--accept-changes'])).toThrow('Unknown option: --accept-changes')
  })

  it('parses reserved assist and migration options', () => {
    const assisted = parseArgs([
      'my-project',
      '--assist',
      '--from',
      '../M9A',
    ])
    const migration = parseArgs([
      '--migrate',
      '.',
      '--target',
      './new-project',
      '--dry-run',
    ])

    expect(assisted.assist).toBe(true)
    expect(assisted.from).toBe('../M9A')
    expect(migration.migrate).toBe('.')
    expect(migration.target).toBe('./new-project')
    expect(migration.dryRun).toBe(true)
  })

  it('parses backup inspection and restore preview options', () => {
    expect(parseArgs(['--list-backups']).listBackups).toBe(true)
    expect(parseArgs(['--show-backup', 'backup-1']).showBackup).toBe('backup-1')
    expect(parseArgs(['--restore', 'backup-2', '--dry-run'])).toMatchObject({
      restore: 'backup-2',
      dryRun: true,
    })
  })
})

describe('validateCommandModes', () => {
  it.each([
    {
      argv: [
        '--doctor',
        '--sync',
        'version',
        '--version',
        '9.9.9',
      ],
      modes: '--doctor, --sync',
    },
    {
      argv: [
        '--clean-cache',
        '--restore',
        'backup-1',
      ],
      modes: '--restore, --clean-cache',
    },
    {
      argv: ['--list-backups', '--show-backup', 'backup-1'],
      modes: '--list-backups, --show-backup',
    },
    {
      argv: [
        '--update',
        'schema',
        '--add',
        'github',
      ],
      modes: '--update, --add',
    },
    {
      argv: [
        '--mcp',
        '--doctor',
      ],
      modes: '--doctor, --mcp',
    },
    {
      argv: [
        'new-project',
        '--doctor',
      ],
      modes: 'create, --doctor',
    },
    {
      argv: [
        '--help',
        '--doctor',
      ],
      modes: '--help, --doctor',
    },
    {
      argv: [
        '--cli-version',
        '--mcp',
      ],
      modes: '--cli-version, --mcp',
    },
  ])('rejects conflicting command modes: $modes', ({ argv, modes }) => {
    expect(() => validateCommandModes(parseArgs(argv))).toThrow(
      `Command modes are mutually exclusive; choose only one: ${modes}`,
    )
  })

  it.each([
    { argv: [] },
    {
      argv: [
        '--doctor',
        '--report',
      ],
    },
    {
      argv: [
        '--update',
        'schema',
        '--update',
        'node-deps',
      ],
    },
    {
      argv: [
        '--add',
        'dev-tools',
        '--add',
        'github',
      ],
    },
    {
      argv: [
        'new-project',
        '--add',
        'github',
      ],
    },
    { argv: ['--list-backups'] },
    { argv: ['--show-backup', 'backup-1', '--report'] },
    { argv: ['--restore', 'backup-1', '--dry-run'] },
  ])('accepts a single command mode: $argv', ({ argv }) => {
    expect(() => validateCommandModes(parseArgs(argv))).not.toThrow()
  })

  it('rejects dry-run without restore', () => {
    expect(() => validateCommandModes(parseArgs(['--dry-run']))).toThrow('--dry-run requires --restore <backup-id>.')
  })
})

describe('formatCliHelp', () => {
  it('documents creation, maintenance, version, and representative examples', () => {
    const help = formatCliHelp('1.2.3')

    expect(help).toContain('create-maa-project 1.2.3')
    expect(help).toContain('create-maa-project [project] [creation options]')
    expect(help).toContain('--add <addon>')
    expect(help).toContain('--sync <target> [value]')
    expect(help).toContain('--update <target>')
    expect(help).toContain('--doctor')
    expect(help).toContain('--list-backups')
    expect(help).toContain('--show-backup <backup-id>')
    expect(help).toContain('--restore <backup-id>')
    expect(help).toContain('--dry-run')
    expect(help).toContain('--clean-cache')
    expect(help).toContain('--mcp')
    expect(help).toContain('-V, --cli-version')
    expect(help).toContain('--version <semver>')
    expect(help).toContain('Examples:')
  })
})
