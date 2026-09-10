import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  inferPromptProjectIdentity,
  labelText,
  linesForSelectMany,
  promptForCreateOptions,
  setupAddons,
} from '../src/prompt.js'
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
      'dependabot',
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
      'dependabot',
    ])
  })
})

describe('repository feature checkbox indentation', () => {
  const choices = [
    { value: 'dev-tools', label: 'dev-tools' },
    { value: 'github', label: 'github', indent: 1 },
    { value: 'git-cliff', label: 'git-cliff', indent: 2 },
  ]

  it('indents the checkbox instead of the choice label', () => {
    const lines = linesForSelectMany('en', 'Repository features', choices, 0, new Set(['dev-tools', 'github']), {})

    expect(lines.slice(1, 4)).toEqual([
      '> [x] dev-tools',
      '    [x] github',
      '      [ ] git-cliff',
    ])
    for (const line of lines.slice(1, 4)) {
      expect(line).toMatch(/^[> ] (?: {2})*\[[ x]\] \S/)
    }
  })

  it('renders indentation before the checkbox for every prompt language', () => {
    for (const language of ['en', 'zh-CN'] as const) {
      const lines = linesForSelectMany(language, 'Repository features', choices, 0, new Set(), {})

      expect(lines.slice(1, 4)).toEqual(
        choices.map((choice, index) => {
          const marker = index === 0 ? '>' : ' '
          return `${marker} ${'  '.repeat(choice.indent ?? 0)}[ ] ${choice.label}`
        }),
      )
    }
  })

  it('keeps the note above the choices and the message below the instruction', () => {
    const lines = linesForSelectMany(
      'en',
      'Repository features',
      choices,
      0,
      new Set(),
      { note: 'Indented features also enable their parent features.' },
      'Select at least one item.',
    )

    expect(lines[1]).toBe('  Indented features also enable their parent features.')
    expect(lines[2]).toBe('> [ ] dev-tools')
    expect(lines.at(-1)).toBe('  Select at least one item.')
  })

  it('localizes the repository feature note for zh-CN', () => {
    const note = labelText('zh-CN', {
      en: 'Indented features also enable their parent features.',
      zhCN: '缩进的功能会一并启用其上级功能。',
    })

    expect(note).toBe('缩进的功能会一并启用其上级功能。')
    expect(linesForSelectMany('zh-CN', '仓库功能', choices, 0, new Set(), { note })[1]).toBe(`  ${note}`)
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
    await expect(promptForCreateOptions(parseArgs(['--yes']))).rejects.toThrow(
      'requires an explicit target name or "."',
    )
    await expect(promptForCreateOptions(parseArgs(['.', '--no-interactive']))).resolves.toMatchObject({ name: '.' })
    await expect(promptForCreateOptions(parseArgs(['.', '--yes']))).resolves.toMatchObject({
      name: '.',
      yes: true,
      noInteractive: true,
    })
  })
})
