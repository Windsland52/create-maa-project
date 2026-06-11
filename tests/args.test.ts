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
        expect(options.controller).toBe('Win32')
    })

    it('rejects unknown options', () => {
        expect(() => parseArgs(['--bad'])).toThrow('Unknown option')
    })

    it('rejects add-ons in the pure create scaffold', () => {
        expect(() => parseArgs(['--add', 'resource-pack', 'extra'])).toThrow(
            '--add is not supported in the pure pipeline scaffold.'
        )
    })

    it('parses sync positional value', () => {
        const options = parseArgs(['--sync', 'github-url', 'https://github.com/MaaXYZ/MaaXX'])

        expect(options.sync).toBe('github-url')
        expect(options.syncValue).toBe('https://github.com/MaaXYZ/MaaXX')
    })

    it('parses doctor report mode', () => {
        const options = parseArgs(['--doctor', '--report'])

        expect(options.doctor).toBe(true)
        expect(options.report).toBe(true)
    })

    it('parses explicit git initialization choices', () => {
        expect(parseArgs(['my-project', '--git']).initializeGit).toBe(true)
        expect(parseArgs(['my-project', '--no-git']).initializeGit).toBe(false)
    })

    it('parses explicit stale lock cleanup', () => {
        expect(parseArgs(['--clear-stale-lock']).clearStaleLock).toBe(true)
    })

    it('parses accept changes with optional paths', () => {
        const all = parseArgs(['--accept-changes'])
        const selected = parseArgs(['--accept-changes', 'package.json', 'interface.json'])

        expect(all.acceptChangesRequested).toBe(true)
        expect(all.acceptChanges).toEqual([])
        expect(selected.acceptChangesRequested).toBe(true)
        expect(selected.acceptChanges).toEqual(['package.json', 'interface.json'])
    })

    it('parses reserved assist and migration options', () => {
        const assisted = parseArgs(['my-project', '--assist', '--from', '../M9A'])
        const migration = parseArgs(['--migrate', '.', '--target', './new-project', '--dry-run'])

        expect(assisted.assist).toBe(true)
        expect(assisted.from).toBe('../M9A')
        expect(migration.migrate).toBe('.')
        expect(migration.target).toBe('./new-project')
        expect(migration.dryRun).toBe(true)
    })
})
