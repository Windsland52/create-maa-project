import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inferPromptProjectIdentity, promptForCreateOptions, setupAddons } from '../src/prompt.js'
import { parseArgs } from '../src/args.js'

describe('prompt setup presets', () => {
  it('expands all repository features selected by the interactive setup prompt', () => {
    expect(setupAddons('all', [])).toEqual([
      'dev-tools',
      'github',
      'git-cliff',
      'auto-format',
      'optimize-images',
      'schema-sync',
      'community',
    ])
  })

  it('preserves existing selections before adding setup features', () => {
    expect(
      setupAddons('all', [
        'resource-pack',
        'github',
      ]),
    ).toEqual([
      'resource-pack',
      'github',
      'dev-tools',
      'git-cliff',
      'auto-format',
      'optimize-images',
      'schema-sync',
      'community',
    ])
  })
})

describe('interactive project identity defaults', () => {
  const cwd = resolve('workspace', 'Current Project')

  it('always preserves an explicitly supplied project ID', () => {
    expect(
      inferPromptProjectIdentity(
        {
          name: join('nested', 'Different Folder'),
          slug: 'explicit-project-id',
        },
        cwd,
      ),
    ).toEqual({
      targetName: 'Different Folder',
      slug: 'explicit-project-id',
      displayName: 'Different Folder',
    })
  })

  it('derives current-directory identity from the current directory name', () => {
    expect(inferPromptProjectIdentity({ name: '.' }, cwd)).toEqual({
      targetName: 'Current Project',
      slug: 'current-project',
      displayName: 'Current Project',
    })
  })

  it('uses only the final directory name for a nested relative target', () => {
    expect(inferPromptProjectIdentity({ name: join('parent', 'Final Project') }, cwd)).toEqual({
      targetName: 'Final Project',
      slug: 'final-project',
      displayName: 'Final Project',
    })
  })

  it('uses only the final directory name for an absolute target', () => {
    const target = resolve(cwd, 'elsewhere', 'Absolute Project')

    expect(inferPromptProjectIdentity({ name: target }, cwd)).toEqual({
      targetName: 'Absolute Project',
      slug: 'absolute-project',
      displayName: 'Absolute Project',
    })
  })

  it('does not derive or mutate identity in non-interactive mode', async () => {
    const target = join('nested', 'Non Interactive Project')
    const options = parseArgs([
      target,
      '--slug',
      'kept-verbatim',
      '--name',
      'Kept Display Name',
      '--no-interactive',
    ])

    await expect(promptForCreateOptions(options)).resolves.toBe(options)
    expect(options).toMatchObject({
      name: target,
      slug: 'kept-verbatim',
      displayName: 'Kept Display Name',
    })
  })

  it('requires non-interactive callers to explicitly select a target directory', async () => {
    await expect(promptForCreateOptions(parseArgs(['--no-interactive']))).rejects.toThrow(
      'requires an explicit target name or "."',
    )
    await expect(promptForCreateOptions(parseArgs(['.', '--no-interactive']))).resolves.toMatchObject({ name: '.' })
  })
})
