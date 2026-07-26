import { describe, expect, it } from 'vitest'
import { assertValidSemVer, isValidSemVer } from '../src/semver.js'
import { createProject } from '../src/scaffold.js'
import { parseArgs } from '../src/args.js'

describe('SemVer 2.0.0 validation', () => {
  it.each([
    '0.0.0',
    '1.2.3',
    '999999999999999999999999.888888888888888888888888.777777777777777777777777',
  ])('accepts valid core version %s', (version) => {
    expect(isValidSemVer(version)).toBe(true)
  })

  it.each([
    '',
    '1',
    '1.2',
    '1.2.3.4',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '-1.2.3',
    '1.-2.3',
    '1.2.-3',
  ])('rejects invalid core version %s', (version) => {
    expect(isValidSemVer(version)).toBe(false)
  })

  it.each([
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-0.3.7',
    '1.0.0-x.7.z.92',
    '1.0.0-x-y-z.--',
    '1.0.0-0',
    '1.0.0-01a',
    '1.0.0--',
  ])('accepts valid prerelease version %s', (version) => {
    expect(isValidSemVer(version)).toBe(true)
  })

  it.each([
    '1.0.0-',
    '1.0.0-.alpha',
    '1.0.0-alpha.',
    '1.0.0-alpha..1',
    '1.0.0-01',
    '1.0.0-00',
    '1.0.0-001.alpha',
    '1.0.0-alpha_1',
    '1.0.0-alpha!',
    '1.0.0-α',
  ])('rejects invalid prerelease version %s', (version) => {
    expect(isValidSemVer(version)).toBe(false)
  })

  it.each([
    '1.0.0+001',
    '1.0.0+000',
    '1.0.0+20130313144700',
    '1.0.0+exp.sha.5114f85',
    '1.0.0+21AF26D3----117B344092BD',
    '1.0.0-alpha+001',
    '1.0.0-beta+exp.sha.5114f85',
  ])('accepts valid build metadata version %s', (version) => {
    expect(isValidSemVer(version)).toBe(true)
  })

  it.each([
    '1.0.0+',
    '1.0.0+.build',
    '1.0.0+build.',
    '1.0.0+build..1',
    '1.0.0+build_1',
    '1.0.0+build!',
    '1.0.0+build+meta',
    '1.0.0+α',
  ])('rejects invalid build metadata version %s', (version) => {
    expect(isValidSemVer(version)).toBe(false)
  })

  it.each([
    'v1.0.0',
    '=1.0.0',
    ' 1.0.0',
    '1.0.0 ',
    '1.0.0\n',
    '1.0.0-alpha +build',
  ])('rejects non-SemVer syntax %s', (version) => {
    expect(isValidSemVer(version)).toBe(false)
  })

  it('throws the shared user-facing error for invalid versions', () => {
    expect(() => assertValidSemVer('1.0.0-alpha..1')).toThrow(
      'Invalid version "1.0.0-alpha..1". Use a SemVer version such as 0.1.0.',
    )
  })

  it('does not throw for a fully qualified SemVer', () => {
    expect(() => assertValidSemVer('2.0.0-rc.1+build.42')).not.toThrow()
  })

  it('is enforced when creating a project', async () => {
    const options = parseArgs([
      'semver-invalid-create',
      '--version',
      '1.0.0-alpha..1',
      '--no-interactive',
    ])

    await expect(createProject(options, { detectGitTree: async () => false })).rejects.toThrow(
      'Invalid version "1.0.0-alpha..1"',
    )
  })
})
