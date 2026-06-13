import { describe, expect, it } from 'vitest'
import { setupAddons } from '../src/prompt.js'

describe('prompt setup presets', () => {
  it('expands all repository features selected by the interactive setup prompt', () => {
    expect(setupAddons('all', [])).toEqual([
      'dev-tools',
      'github',
      'git-cliff',
      'auto-format',
      'optimize-images',
      'schema-sync',
      'community'
    ])
  })

  it('preserves existing selections before adding setup features', () => {
    expect(
      setupAddons('all', [
        'resource-pack',
        'github'
      ])
    ).toEqual([
      'resource-pack',
      'github',
      'dev-tools',
      'git-cliff',
      'auto-format',
      'optimize-images',
      'schema-sync',
      'community'
    ])
  })
})
