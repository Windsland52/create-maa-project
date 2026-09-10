import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  confirmHint,
  confirmKeyResult,
  confirmLines,
  displayWidth,
  inferPromptProjectIdentity,
  isPromptCancelled,
  labelText,
  linesForSelectMany,
  linesForSelectOne,
  PROMPT_CANCELLED_EXIT_CODE,
  PromptCancelledError,
  promptForCreateOptions,
  setupAddons,
  setupChoices,
  wrapToColumns,
} from '../src/prompt.js'
import { parseArgs } from '../src/args.js'

describe('prompt setup presets', () => {
  it('expands all repository features selected by the interactive setup prompt', () => {
    expect(setupAddons('all', [])).toEqual([
      'dev-tools',
      'vscode',
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
      'vscode',
      'git-cliff',
      'auto-format',
      'optimize-images',
      'schema-sync',
      'community',
      'dependabot',
    ])
  })

  it('includes editor integration in the All preset so presets keep the previous behaviour', () => {
    // --add dev-tools no longer writes .vscode; the All preset and the interactive feature
    // prompt still enable it, so preset users see no change.
    expect(setupAddons('all', [])).toContain('vscode')
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

describe('setup preset descriptions', () => {
  it('summarizes the All preset instead of listing add-on slugs', () => {
    // The exhaustive list is pinned by the setupAddons tests above; the prompt should
    // convey what the preset is for without enumerating implementation-level names.
    expect(setupAddons('all', [])).toHaveLength(9)

    // "community" is also a plain English word, so only the distinctive slug forms are
    // meaningful evidence that the description stopped enumerating add-ons.
    const distinctiveSlugs = setupAddons('all', []).filter((addon) => addon.includes('-'))

    for (const language of ['en', 'zh-CN'] as const) {
      const all = setupChoices(language)[0]
      expect(all?.value).toBe('all')
      const description = all?.description ?? ''

      for (const slug of distinctiveSlugs) expect(description.toLowerCase()).not.toContain(slug)
      expect(description).not.toContain('github')
      expect(description.length).toBeLessThan(70)

      const categories =
        language === 'zh-CN' ? ['开发工具', 'GitHub', '社区文件'] : ['dev tools', 'GitHub', 'community']
      for (const category of categories) expect(description).toContain(category)
    }
  })

  it('keeps every preset description on a single row at 80 columns', () => {
    for (const language of ['en', 'zh-CN'] as const) {
      for (const choice of setupChoices(language)) {
        const rendered = linesForSelectOne(language, 'Setup', [choice], 0).find((line) =>
          line.trimStart().startsWith(choice.description ?? '\u0000'),
        )
        expect(rendered, `${language} ${choice.value} description row`).toBeDefined()
        expect(wrapToColumns(rendered ?? '', 80)).toHaveLength(1)
      }
    }
  })

  it('explains the minimal and custom presets', () => {
    for (const language of ['en', 'zh-CN'] as const) {
      const [all, minimal, custom] = setupChoices(language)
      expect(all?.description?.length ?? 0).toBeGreaterThan(0)
      expect(minimal?.value).toBe('minimal')
      expect(minimal?.description).toMatch(language === 'zh-CN' ? /不添加/ : /no repository features/i)
      expect(custom?.description).toMatch(language === 'zh-CN' ? /逐项选择/ : /one by one/i)
    }
  })

  it('renders each preset description under its label', () => {
    const lines = linesForSelectOne('en', 'Setup', setupChoices('en'), 0)

    expect(lines[0]).toBe('Setup:')
    expect(lines[1]).toBe('> All (Recommended)')
    expect(lines[2]).toBe('    Add dev tools, GitHub automation, and community files.')
    expect(lines).toContain('    Add no repository features.')
    expect(lines).toContain('    Choose repository features one by one.')
    expect(lines.at(-1)).toBe('  Up/Down to move, Enter to select.')
  })
})

describe('confirmation prompts', () => {
  it('uses single-key y/n answers', () => {
    expect(confirmKeyResult({ name: 'y' }, false)).toBe(true)
    expect(confirmKeyResult({ name: 'Y' }, false)).toBe(true)
    expect(confirmKeyResult({ name: 'n' }, true)).toBe(false)
    expect(confirmKeyResult({ name: 'N' }, true)).toBe(false)
    expect(confirmKeyResult({ name: 'return' }, true)).toBe(true)
    expect(confirmKeyResult({ name: 'enter' }, false)).toBe(false)
  })

  it('ignores unrelated keys so the answer stays pending', () => {
    for (const name of ['up', 'down', 'k', 'j', 'space', 'a', undefined]) {
      expect(confirmKeyResult({ name }, true)).toBeUndefined()
    }
  })

  it('advertises the default with a capitalised key hint', () => {
    expect(confirmHint(true)).toBe('Y/n')
    expect(confirmHint(false)).toBe('y/N')
    expect(confirmLines('Initialize Git repository', true)).toEqual(['Initialize Git repository (Y/n):'])
    expect(confirmLines('Add extra resource pack', false)).toEqual(['Add extra resource pack (y/N):'])
  })
})

describe('prompt cancellation', () => {
  it('classifies interrupts so the CLI can exit quietly with 130', () => {
    const error = new PromptCancelledError('已取消交互。')

    expect(error.code).toBe('CMP_CANCELLED')
    expect(error.name).toBe('PromptCancelledError')
    expect(isPromptCancelled(error)).toBe(true)
    expect(isPromptCancelled(Object.assign(new Error('readline was closed'), { code: 'CMP_CANCELLED' }))).toBe(true)
    expect(isPromptCancelled(new Error('Aborted with Ctrl+C'))).toBe(false)
    expect(isPromptCancelled(undefined)).toBe(false)
    expect(PROMPT_CANCELLED_EXIT_CODE).toBe(130)
  })
})

describe('width aware rendering', () => {
  it('counts CJK and fullwidth characters as two columns', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('仓库功能')).toBe(8)
    // Arrows are East Asian ambiguous width; terminals render them as one column.
    expect(displayWidth('↑/↓ 移动')).toBe(8)
    expect(displayWidth('（推荐）')).toBe(8)
    expect(displayWidth('')).toBe(0)
  })

  it('leaves lines that already fit untouched', () => {
    expect(wrapToColumns('  Up/Down to move', 20)).toEqual(['  Up/Down to move'])
    expect(wrapToColumns('仓库功能', 8)).toEqual(['仓库功能'])
  })

  it('wraps long ASCII lines on word boundaries and keeps the indentation', () => {
    const rows = wrapToColumns('  Up/Down to move, Space to toggle, Enter to confirm. (At least one required.)', 40)

    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(40)
      expect(row.startsWith('  ')).toBe(true)
      expect(row.startsWith('   ')).toBe(false)
      expect(row.endsWith(' ')).toBe(false)
    }
    expect(rows.map((row) => row.trim()).join(' ')).toBe(
      'Up/Down to move, Space to toggle, Enter to confirm. (At least one required.)',
    )
  })

  it('hard-breaks long CJK runs that have no spaces', () => {
    const description = `    ${'添加全部仓库功能：'.repeat(6)}`
    const rows = wrapToColumns(description, 30)

    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(30)
      expect(row.startsWith('    ')).toBe(true)
    }
  })

  it('breaks CJK text after punctuation instead of splitting add-on names', () => {
    // The setup summary deliberately no longer enumerates add-ons, so this exercises the
    // wrapping rules directly on the CJK enumeration that motivated them.
    const description = `    添加全部仓库功能：${setupAddons('all', []).join('、')}`
    const rows = wrapToColumns(description, 80)

    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(80)
      // A row must never begin with the separator.
      expect(row.trimStart().startsWith('、')).toBe(false)
    }
    for (const addon of setupAddons('all', [])) {
      expect(
        rows.some((row) => row.includes(addon)),
        `${addon} was split across rows`,
      ).toBe(true)
    }
    expect(rows.join('')).not.toContain('\u200b')
  })

  it('keeps every rendered prompt row inside a narrow terminal', () => {
    const lines = [
      ...linesForSelectOne('en', 'Setup', setupChoices('en'), 0),
      ...linesForSelectOne('zh-CN', '仓库配置', setupChoices('zh-CN'), 0),
      ...linesForSelectMany(
        'en',
        'Control targets',
        [
          { value: 'Adb', label: 'Android / Emulator (Adb)' },
          { value: 'Gamepad', label: 'Gamepad (Windows)' },
        ],
        0,
        new Set(['Adb']),
        { requireOne: true },
      ),
    ]

    for (const columns of [40, 60, 80]) {
      for (const line of lines) {
        for (const row of wrapToColumns(line, columns)) {
          expect(displayWidth(row), `${JSON.stringify(row)} at ${columns} columns`).toBeLessThanOrEqual(columns)
        }
      }
    }
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
