import { describe, expect, it } from 'vitest'
import { upsertOverrideContent } from '../scripts/update-audit-overrides.js'

/** The workspace shape since all overrides were cleared: no overrides block to upsert into. */
const ALLOW_BUILDS_ONLY = 'allowBuilds:\n  esbuild: false\n'

describe('upsertOverrideContent', () => {
  it('appends a fresh overrides block after allowBuilds without re-parenting its children', () => {
    // Regression: the block used to be spliced in between the allowBuilds key and its children,
    // turning `esbuild: false` into a boolean overrides.esbuild that pnpm install rejects.
    expect(upsertOverrideContent(ALLOW_BUILDS_ONLY, 'hono', '4.13.7')).toBe(
      'allowBuilds:\n  esbuild: false\n\noverrides:\n  hono: 4.13.7\n',
    )
  })

  it('fills a fresh block in case-insensitive key order across repeated upserts', () => {
    let content = upsertOverrideContent(ALLOW_BUILDS_ONLY, 'ip-address', '10.7.1')
    content = upsertOverrideContent(content, 'hono', '4.13.7')
    expect(content).toBe('allowBuilds:\n  esbuild: false\n\noverrides:\n  hono: 4.13.7\n  ip-address: 10.7.1\n')
  })

  it('bumps an existing pin in place and leaves the rest of the document untouched', () => {
    const before = [
      'allowBuilds:',
      '  esbuild: false',
      '',
      'overrides:',
      '  "@hono/node-server": 2.0.10',
      '  hono: 4.12.34',
      '',
      'minimumReleaseAge: 1440',
      '',
    ].join('\n')
    expect(upsertOverrideContent(before, 'hono', '4.13.7')).toBe(
      [
        'allowBuilds:',
        '  esbuild: false',
        '',
        'overrides:',
        '  "@hono/node-server": 2.0.10',
        '  hono: 4.13.7',
        '',
        'minimumReleaseAge: 1440',
        '',
      ].join('\n'),
    )
  })

  it('inserts a new pin in sorted position inside an existing block', () => {
    const before = [
      'allowBuilds:',
      '  esbuild: false',
      '',
      'overrides:',
      '  "@hono/node-server": 2.0.10',
      '  hono: 4.12.34',
      '',
    ].join('\n')
    expect(upsertOverrideContent(before, 'ip-address', '10.7.1')).toBe(
      [
        'allowBuilds:',
        '  esbuild: false',
        '',
        'overrides:',
        '  "@hono/node-server": 2.0.10',
        '  hono: 4.12.34',
        '  ip-address: 10.7.1',
        '',
      ].join('\n'),
    )
  })

  it('quotes scoped package keys when creating a fresh block', () => {
    expect(upsertOverrideContent(ALLOW_BUILDS_ONLY, '@hono/node-server', '2.0.10')).toBe(
      'allowBuilds:\n  esbuild: false\n\noverrides:\n  "@hono/node-server": 2.0.10\n',
    )
  })

  it('returns the document unchanged when the pin already matches', () => {
    const pinned = 'allowBuilds:\n  esbuild: false\n\noverrides:\n  hono: 4.13.7\n'
    expect(upsertOverrideContent(pinned, 'hono', '4.13.7')).toBe(pinned)
  })

  it('always ends the document with exactly one newline', () => {
    expect(upsertOverrideContent('allowBuilds:\n  esbuild: false', 'hono', '4.13.7')).toBe(
      'allowBuilds:\n  esbuild: false\n\noverrides:\n  hono: 4.13.7\n',
    )
  })
})
