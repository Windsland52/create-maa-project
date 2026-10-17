import { describe, expect, it } from 'vitest'
import { normalizeMaafwVersion } from '../src/maafw-version.js'

describe('normalizeMaafwVersion', () => {
  it('treats both spellings of a prerelease as one version', () => {
    expect(normalizeMaafwVersion('5.15.0b1')).toBe(normalizeMaafwVersion('5.15.0-beta.1'))
    expect(normalizeMaafwVersion('v5.15.0-beta.1')).toBe('5.15.0b1')
    expect(normalizeMaafwVersion('5.15.0-rc.2')).toBe(normalizeMaafwVersion('5.15.0rc2'))
  })

  it('keeps a release apart from a prerelease of the same line', () => {
    expect(normalizeMaafwVersion('5.15.0')).not.toBe(normalizeMaafwVersion('5.15.0b1'))
    expect(normalizeMaafwVersion('5.14.3')).toBe('5.14.3')
  })
})
