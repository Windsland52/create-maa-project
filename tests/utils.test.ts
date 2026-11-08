import { describe, expect, it } from 'vitest'
import { assertValidSlug } from '../src/utils.js'

describe('assertValidSlug', () => {
  it('accepts ordinary kebab-case slugs', () => {
    for (const slug of [
      'x',
      'my-project',
      'mxu-example',
      'python-helper',
    ]) {
      expect(() => assertValidSlug(slug)).not.toThrow()
    }
  })

  it('rejects invalid characters', () => {
    for (const slug of [
      'My Project',
      '_bad',
      'bad_',
      '',
    ]) {
      expect(() => assertValidSlug(slug)).toThrow('Invalid project ID')
    }
  })

  // The release build renames the GUI entrypoint to the slug inside a package that already ships
  // binaries like mxu or directories like python/ — a collision would clobber a packaged entry.
  it('rejects slugs reserved by the release package layout', () => {
    for (const slug of [
      'mxu',
      'python',
      'agent',
      'resource',
      'mfaa',
      'maapicli',
      'runtimes',
    ]) {
      expect(() => assertValidSlug(slug)).toThrow('reserved by the release package layout')
    }
  })
})
