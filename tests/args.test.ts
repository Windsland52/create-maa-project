import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'

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
      'Win32'
    ])

    expect(options.name).toBe('测试项目')
    expect(options.displayName).toBe('显示名')
    expect(options.template).toBe('agent')
    expect(options.slug).toBe('arknights-helper')
    expect(options.skipDownload).toBe(true)
    expect(options.controllers).toEqual([
      'Win32'
    ])
  })

  it('parses multiple control targets', () => {
    const options = parseArgs([
      '--controller',
      'ADB,Win32',
      '--controller',
      'macos'
    ])

    expect(options.controllers).toEqual([
      'Adb',
      'Win32',
      'MacOS'
    ])
  })

  it('rejects unknown options', () => {
    expect(() =>
      parseArgs([
        '--bad'
      ])
    ).toThrow('Unknown option')
  })

  it('parses resource pack folder after --add resource-pack', () => {
    const options = parseArgs([
      '--add',
      'resource-pack',
      'extra',
      '--label',
      '额外资源'
    ])

    expect(options.add).toEqual([
      'resource-pack'
    ])
    expect(options.resourcePackSlug).toBe('extra')
    expect(options.label).toBe('额外资源')
  })

  it('parses sync positional value', () => {
    const options = parseArgs([
      '--sync',
      'github-url',
      'https://github.com/MaaXYZ/MaaXX'
    ])

    expect(options.sync).toBe('github-url')
    expect(options.syncValue).toBe('https://github.com/MaaXYZ/MaaXX')
  })

  it('parses doctor report mode', () => {
    const options = parseArgs([
      '--doctor',
      '--report'
    ])

    expect(options.doctor).toBe(true)
    expect(options.report).toBe(true)
  })

  it('parses MCP server mode', () => {
    const options = parseArgs([
      '--mcp'
    ])

    expect(options.mcp).toBe(true)
  })

  it('parses interactive prompt language', () => {
    expect(
      parseArgs([
        '--lang',
        'zh'
      ]).lang
    ).toBe('zh-CN')
    expect(
      parseArgs([
        '--lang',
        'en'
      ]).lang
    ).toBe('en')
    expect(() =>
      parseArgs([
        '--lang',
        'fr'
      ])
    ).toThrow('--lang must be one of: auto, en, zh-CN')
  })

  it('parses explicit git initialization choices', () => {
    expect(
      parseArgs([
        'my-project',
        '--git'
      ]).initializeGit
    ).toBe(true)
    expect(
      parseArgs([
        'my-project',
        '--no-git'
      ]).initializeGit
    ).toBe(false)
  })

  it('parses explicit stale lock cleanup', () => {
    expect(
      parseArgs([
        '--clear-stale-lock'
      ]).clearStaleLock
    ).toBe(true)
  })

  it('parses accept changes with optional paths', () => {
    const all = parseArgs([
      '--accept-changes'
    ])
    const selected = parseArgs([
      '--accept-changes',
      'package.json',
      'interface.json'
    ])

    expect(all.acceptChangesRequested).toBe(true)
    expect(all.acceptChanges).toEqual([])
    expect(selected.acceptChangesRequested).toBe(true)
    expect(selected.acceptChanges).toEqual([
      'package.json',
      'interface.json'
    ])
  })

  it('parses reserved assist and migration options', () => {
    const assisted = parseArgs([
      'my-project',
      '--assist',
      '--from',
      '../M9A'
    ])
    const migration = parseArgs([
      '--migrate',
      '.',
      '--target',
      './new-project',
      '--dry-run'
    ])

    expect(assisted.assist).toBe(true)
    expect(assisted.from).toBe('../M9A')
    expect(migration.migrate).toBe('.')
    expect(migration.target).toBe('./new-project')
    expect(migration.dryRun).toBe(true)
  })
})
