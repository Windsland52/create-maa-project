import { createInterface } from 'node:readline/promises'
import { emitKeypressEvents } from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import { basename, join, resolve } from 'node:path'
import type { CliOptions, ControllerKind, LicenseKind, TemplateName } from './types.js'
import { exists, normalizeSlug } from './utils.js'
import { CONTROLLER_KINDS, DEFAULT_CONTROLLER_KINDS } from './controllers.js'
import { resolvePromptLanguage, type PromptLanguage } from './lang.js'

type SetupPreset = 'all' | 'minimal' | 'custom'

type LocalizedText = {
  en: string
  zhCN: string
}

const TEXT = {
  addExtraResourcePack: {
    en: 'Add extra resource pack',
    zhCN: '添加额外资源包',
  },
  atLeastOneRequired: {
    en: 'At least one required.',
    zhCN: '至少选择一项。',
  },
  controlTargets: {
    en: 'Control targets',
    zhCN: '控制目标',
  },
  custom: {
    en: 'Custom',
    zhCN: '自定义',
  },
  displayName: {
    en: 'Display name',
    zhCN: '显示名称',
  },
  featureDependencies: {
    en: 'Indented features also enable their parent features.',
    zhCN: '缩进的功能会一并启用其上级功能。',
  },
  initializeGitRepository: {
    en: 'Initialize Git repository',
    zhCN: '初始化 Git 仓库',
  },
  license: {
    en: 'License',
    zhCN: '许可证',
  },
  minimal: {
    en: 'Minimal',
    zhCN: '最小',
  },
  no: {
    en: 'No',
    zhCN: '否',
  },
  noLicense: {
    en: 'No license',
    zhCN: '无许可证',
  },
  none: {
    en: 'none',
    zhCN: '无',
  },
  promptCancelled: {
    en: 'Prompt cancelled.',
    zhCN: '已取消交互。',
  },
  projectFolder: {
    en: 'Project folder',
    zhCN: '项目目录',
  },
  projectId: {
    en: 'Project ID',
    zhCN: '项目 ID',
  },
  projectIdAsciiOnly: {
    en: 'Project ID must contain ASCII letters, numbers, or hyphens.',
    zhCN: '项目 ID 只能包含 ASCII 字母、数字或连字符。',
  },
  projectType: {
    en: 'Project type',
    zhCN: '项目类型',
  },
  repositoryFeatures: {
    en: 'Repository features',
    zhCN: '仓库功能',
  },
  resourcePackDisplayName: {
    en: 'Resource pack display name',
    zhCN: '资源包显示名称',
  },
  resourcePackFolder: {
    en: 'Resource pack folder',
    zhCN: '资源包目录',
  },
  resourcePackFolderAsciiOnly: {
    en: 'Resource pack folder must contain ASCII letters, numbers, or hyphens.',
    zhCN: '资源包目录只能包含 ASCII 字母、数字或连字符。',
  },
  selectAtLeastOneItem: {
    en: 'Select at least one item.',
    zhCN: '请至少选择一项。',
  },
  setup: {
    en: 'Setup',
    zhCN: '仓库配置',
  },
  setupAll: {
    en: 'All',
    zhCN: '全部',
  },
  setupAllDescription: {
    en: 'Add every repository feature: ',
    zhCN: '添加全部仓库功能：',
  },
  setupCustomDescription: {
    en: 'Choose repository features one by one.',
    zhCN: '逐项选择仓库功能。',
  },
  setupMinimalDescription: {
    en: 'Add no repository features.',
    zhCN: '不添加任何仓库功能。',
  },
  usingProjectId: {
    en: 'Using project ID',
    zhCN: '使用项目 ID',
  },
  yes: {
    en: 'Yes',
    zhCN: '是',
  },
} satisfies Record<string, LocalizedText>

export async function promptForCreateOptions(options: CliOptions): Promise<CliOptions> {
  if (options.noInteractive || !process.stdin.isTTY || !process.stdout.isTTY) {
    if (options.name === undefined) {
      throw new Error(
        'Non-interactive project creation requires an explicit target name or "." for the current directory.',
      )
    }
    return options
  }

  const language = resolvePromptLanguage(options.lang)
  const rl = createInterface({ input, output })
  const asker = createQuestionAsker(rl, language)
  try {
    if (!options.name) {
      const answer = await asker.ask(question(label(language, TEXT.projectFolder), 'maa-project'))
      options.name = answer.trim() || 'maa-project'
    }
    const identity = inferPromptProjectIdentity(options)
    if (options.slug === undefined) {
      if (!identity.slug) {
        options.slug = await askAsciiProjectId(asker, language)
      } else if (identity.targetName !== identity.slug) {
        output.write(`${label(language, TEXT.usingProjectId)}: ${identity.slug}\n`)
        options.slug = identity.slug
      } else {
        options.slug = identity.slug
      }
    }
    if (!options.displayName) {
      const fallbackDisplayName = identity.displayName
      const answer = await asker.ask(question(label(language, TEXT.displayName), fallbackDisplayName))
      options.displayName = answer.trim() || fallbackDisplayName
    }
    if (!options.explicitTemplate) {
      options.template = await selectOne<TemplateName>(
        rl,
        language,
        label(language, TEXT.projectType),
        [
          { value: 'pipeline', label: choice(language, 'Pipeline', '流水线（pipeline）') },
          {
            value: 'agent',
            label: choice(language, 'Pipeline + Python Agent', '流水线 + Python Agent'),
          },
        ],
        'pipeline',
      )
    }
    if (!options.license) {
      options.license = await selectOne<LicenseKind>(
        rl,
        language,
        label(language, TEXT.license),
        [
          {
            value: 'AGPL-3.0-or-later',
            label: recommendedLabel(language, 'AGPL-3.0-or-later'),
          },
          { value: 'MIT', label: 'MIT' },
          { value: 'None', label: label(language, TEXT.noLicense) },
        ],
        'AGPL-3.0-or-later',
      )
    }
    if (!options.controllers?.length) {
      options.controllers = await controllerMultiChoice(rl, language)
    }
    if (options.add.length === 0) {
      const setup = await selectOne<SetupPreset>(
        rl,
        language,
        label(language, TEXT.setup),
        setupChoices(language),
        'all',
      )
      options.add = setupAddons(setup, options.add)
      if (setup === 'custom') {
        options.add = addUnique(options.add, await customRepositoryFeatures(rl, language))
      }
    }
    await promptForResourcePack(asker, rl, options, language)
    if (options.initializeGit === undefined) {
      const targetRoot = resolve(process.cwd(), options.name ?? '.')
      const parentHasGit = await isInsideGitTree(resolve(targetRoot, '..'))
      options.initializeGit = await yesNo(rl, language, label(language, TEXT.initializeGitRepository), !parentHasGit)
    }
    return options
  } finally {
    asker.dispose()
    rl.close()
  }
}

type QuestionAsker = {
  ask: (promptText: string) => Promise<string>
  dispose: () => void
}

/**
 * readline rejects a pending question with an internal AbortError when Ctrl+C
 * closes the interface. Owning the SIGINT event keeps the cancel path localized
 * and quiet instead of leaking "Aborted with Ctrl+C" to the user.
 */
function createQuestionAsker(rl: ReturnType<typeof createInterface>, language: PromptLanguage): QuestionAsker {
  let rejectPending: ((error: Error) => void) | null = null
  const onSigint = (): void => {
    rejectPending?.(cancelled(language))
  }
  rl.on('SIGINT', onSigint)
  return {
    ask(promptText: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        rejectPending = reject
        rl.question(promptText).then(
          (answer) => {
            rejectPending = null
            resolve(answer)
          },
          (error: unknown) => {
            rejectPending = null
            reject(error instanceof Error ? error : new Error(String(error)))
          },
        )
      })
    },
    dispose(): void {
      rl.off('SIGINT', onSigint)
    },
  }
}

export function inferPromptProjectIdentity(
  options: Pick<CliOptions, 'name' | 'slug' | 'displayName'>,
  cwd = process.cwd(),
): { targetName: string; slug: string; displayName: string } {
  const targetName = basename(resolve(cwd, options.name ?? '.'))
  return {
    targetName,
    slug: options.slug ?? normalizeSlug(targetName),
    displayName: options.displayName ?? targetName,
  }
}

async function askAsciiProjectId(asker: QuestionAsker, language: PromptLanguage): Promise<string> {
  for (;;) {
    const answer = await asker.ask(question(label(language, TEXT.projectId), 'maa-project'))
    const raw = answer.trim()
    if (!raw) return 'maa-project'
    const slug = normalizeSlug(raw)
    if (slug) {
      if (slug !== raw) output.write(`${label(language, TEXT.usingProjectId)}: ${slug}\n`)
      return slug
    }
    output.write(`${label(language, TEXT.projectIdAsciiOnly)}\n`)
  }
}

async function controllerMultiChoice(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage,
): Promise<ControllerKind[]> {
  return selectMany<ControllerKind>(
    rl,
    language,
    label(language, TEXT.controlTargets),
    CONTROLLER_KINDS.map((kind) => ({
      value: kind,
      label: controllerChoiceLabel(kind, language),
    })),
    DEFAULT_CONTROLLER_KINDS,
    { requireOne: true },
  )
}

const SETUP_ALL_ADDONS = [
  'dev-tools',
  'github',
  'git-cliff',
  'auto-format',
  'optimize-images',
  'schema-sync',
  'community',
  'dependabot',
]

export function setupAddons(setup: SetupPreset, current: string[]): string[] {
  if (setup === 'minimal') return current
  if (setup === 'all') return addUnique(current, SETUP_ALL_ADDONS)
  return current
}

export function setupChoices(language: PromptLanguage): Choice<SetupPreset>[] {
  const separator = language === 'zh-CN' ? '、' : ', '
  return [
    {
      value: 'all',
      label: recommendedLabel(language, label(language, TEXT.setupAll)),
      description: `${label(language, TEXT.setupAllDescription)}${SETUP_ALL_ADDONS.join(separator)}`,
    },
    {
      value: 'minimal',
      label: label(language, TEXT.minimal),
      description: label(language, TEXT.setupMinimalDescription),
    },
    {
      value: 'custom',
      label: label(language, TEXT.custom),
      description: label(language, TEXT.setupCustomDescription),
    },
  ]
}

async function customRepositoryFeatures(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage,
): Promise<string[]> {
  return selectMany<string>(
    rl,
    language,
    label(language, TEXT.repositoryFeatures),
    [
      { value: 'dev-tools', label: 'dev-tools' },
      { value: 'github', label: 'github', indent: 1 },
      { value: 'git-cliff', label: 'git-cliff', indent: 2 },
      { value: 'auto-format', label: 'auto-format', indent: 2 },
      { value: 'optimize-images', label: 'optimize-images', indent: 2 },
      { value: 'schema-sync', label: 'schema-sync', indent: 2 },
      { value: 'community', label: 'community', indent: 2 },
      { value: 'dependabot', label: 'dependabot', indent: 2 },
    ],
    [
      'dev-tools',
      'github',
    ],
    {
      note: labelText(language, TEXT.featureDependencies),
    },
  )
}

async function promptForResourcePack(
  asker: QuestionAsker,
  rl: ReturnType<typeof createInterface>,
  options: CliOptions,
  language: PromptLanguage,
): Promise<void> {
  if (!options.add.includes('resource-pack')) {
    const addResourcePack = await confirm(rl, language, label(language, TEXT.addExtraResourcePack), false)
    if (!addResourcePack) return
    options.add = addUnique(options.add, [
      'resource-pack',
    ])
  }
  if (!options.resourcePackSlug) {
    options.resourcePackSlug = await askResourcePackFolder(asker, language)
  }
  if (!options.label) {
    const fallback = displayNameFromFolder(options.resourcePackSlug)
    const answer = await asker.ask(question(label(language, TEXT.resourcePackDisplayName), fallback))
    options.label = answer.trim() || fallback
  }
}

async function askResourcePackFolder(asker: QuestionAsker, language: PromptLanguage): Promise<string> {
  for (;;) {
    const answer = await asker.ask(question(label(language, TEXT.resourcePackFolder), 'extra'))
    const slug = normalizeSlug(answer.trim() || 'extra')
    if (slug) return slug
    output.write(`${label(language, TEXT.resourcePackFolderAsciiOnly)}\n`)
  }
}

function addUnique(existing: string[], values: string[]): string[] {
  const set = new Set(existing)
  for (const value of values) set.add(value)
  return [
    ...set,
  ]
}

function displayNameFromFolder(folder: string): string {
  return folder
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

async function yesNo(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage,
  label: string,
  fallback: boolean,
): Promise<boolean> {
  return confirm(rl, language, label, fallback)
}

export type Choice<T extends string> = {
  value: T
  label: string
  description?: string
  indent?: number
}

type Keypress = {
  ctrl?: boolean
  name?: string
  sequence?: string
}

/**
 * Raised when the user interrupts an interactive prompt with Ctrl+C.
 * The CLI exits quietly with code 130 instead of reporting an error.
 */
export class PromptCancelledError extends Error {
  readonly code = 'CMP_CANCELLED'

  constructor(message: string) {
    super(message)
    this.name = 'PromptCancelledError'
  }
}

export const PROMPT_CANCELLED_EXIT_CODE = 130

export function isPromptCancelled(error: unknown): boolean {
  return error instanceof PromptCancelledError || (error as { code?: string } | null)?.code === 'CMP_CANCELLED'
}

function cancelled(language: PromptLanguage): PromptCancelledError {
  return new PromptCancelledError(labelText(language, TEXT.promptCancelled))
}

export function confirmHint(fallback: boolean): string {
  return fallback ? 'Y/n' : 'y/N'
}

export function confirmKeyResult(key: { name?: string | undefined }, fallback: boolean): boolean | undefined {
  if (key.name === 'y' || key.name === 'Y') return true
  if (key.name === 'n' || key.name === 'N') return false
  if (key.name === 'return' || key.name === 'enter') return fallback
  return undefined
}

let keypressEventsEnabled = false

async function confirm(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage,
  label: string,
  fallback: boolean,
): Promise<boolean> {
  return withSelectablePrompt(rl, language, (render, done) => {
    const onKeypress = (_value: string, key: Keypress): void => {
      if (isCancelKey(key)) {
        done(cancelled(language))
        return
      }
      const answer = confirmKeyResult(key, fallback)
      if (answer === undefined) return
      done(undefined, answer, `${label}: ${labelText(language, answer ? TEXT.yes : TEXT.no)}`)
    }
    render(confirmLines(label, fallback))
    return onKeypress
  })
}

export function confirmLines(label: string, fallback: boolean): string[] {
  return [`${label} (${confirmHint(fallback)}):`]
}

async function selectOne<T extends string>(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage,
  label: string,
  choices: Choice<T>[],
  fallback: T,
): Promise<T> {
  if (choices.length === 0) throw new Error(`${label} has no choices.`)
  let index = Math.max(
    0,
    choices.findIndex((choice) => choice.value === fallback),
  )
  return withSelectablePrompt(rl, language, (render, done) => {
    const onKeypress = (_value: string, key: Keypress): void => {
      if (isCancelKey(key)) {
        done(cancelled(language))
        return
      }
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + choices.length) % choices.length
        render(linesForSelectOne(language, label, choices, index))
        return
      }
      if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % choices.length
        render(linesForSelectOne(language, label, choices, index))
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        done(undefined, choices[index]?.value, `${label}: ${choices[index]?.label ?? ''}`)
      }
    }
    render(linesForSelectOne(language, label, choices, index))
    return onKeypress
  })
}

async function selectMany<T extends string>(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage,
  label: string,
  choices: Choice<T>[],
  fallback: T[],
  options: { requireOne?: boolean; note?: string } = {},
): Promise<T[]> {
  if (choices.length === 0) throw new Error(`${label} has no choices.`)
  let index = 0
  const selected = new Set<T>(fallback)
  return withSelectablePrompt(rl, language, (render, done) => {
    const onKeypress = (_value: string, key: Keypress): void => {
      if (isCancelKey(key)) {
        done(cancelled(language))
        return
      }
      if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + choices.length) % choices.length
        render(linesForSelectMany(language, label, choices, index, selected, options))
        return
      }
      if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % choices.length
        render(linesForSelectMany(language, label, choices, index, selected, options))
        return
      }
      if (key.name === 'space' || key.sequence === ' ') {
        const value = choices[index]?.value
        if (value) {
          if (selected.has(value)) selected.delete(value)
          else selected.add(value)
        }
        render(linesForSelectMany(language, label, choices, index, selected, options))
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        const values = choices.map((choice) => choice.value).filter((value) => selected.has(value))
        if (options.requireOne && values.length === 0) {
          render(
            linesForSelectMany(
              language,
              label,
              choices,
              index,
              selected,
              options,
              labelText(language, TEXT.selectAtLeastOneItem),
            ),
          )
          return
        }
        done(undefined, values, `${label}: ${values.length > 0 ? values.join(', ') : labelText(language, TEXT.none)}`)
      }
    }
    render(linesForSelectMany(language, label, choices, index, selected, options))
    return onKeypress
  })
}

export function linesForSelectOne<T extends string>(
  language: PromptLanguage,
  label: string,
  choices: Choice<T>[],
  index: number,
): string[] {
  return [
    `${label}:`,
    ...choices.flatMap((choice, choiceIndex) => [
      `${choiceIndex === index ? '>' : ' '} ${choice.label}`,
      ...descriptionLines(choice, 2),
    ]),
    `  ${selectOneInstruction(language)}`,
  ]
}

export function linesForSelectMany<T extends string>(
  language: PromptLanguage,
  label: string,
  choices: Choice<T>[],
  index: number,
  selected: Set<T>,
  options: { requireOne?: boolean; note?: string },
  message?: string,
): string[] {
  return [
    `${label}:`,
    ...(options.note
      ? [
          `  ${options.note}`,
        ]
      : []),
    ...choices.flatMap((choice, choiceIndex) => {
      const checked = selected.has(choice.value) ? '[x]' : '[ ]'
      const indent = '  '.repeat(choice.indent ?? 0)
      return [
        `${choiceIndex === index ? '>' : ' '} ${indent}${checked} ${choice.label}`,
        ...descriptionLines(choice, (choice.indent ?? 0) * 2 + 2),
      ]
    }),
    `  ${selectManyInstruction(language)}`,
    ...(options.requireOne
      ? [
          `  ${labelText(language, TEXT.atLeastOneRequired)}`,
        ]
      : []),
    ...(message
      ? [
          `  ${message}`,
        ]
      : []),
  ]
}

function descriptionLines<T extends string>(choice: Choice<T>, indent: number): string[] {
  if (!choice.description) return []
  return [`${' '.repeat(indent + 2)}${choice.description}`]
}

function label(language: PromptLanguage, text: LocalizedText): string {
  return labelText(language, text)
}

export function labelText(language: PromptLanguage, text: LocalizedText): string {
  return language === 'zh-CN' ? text.zhCN : text.en
}

function choice(language: PromptLanguage, english: string, zhCN: string): string {
  return language === 'zh-CN' ? zhCN : english
}

function recommendedLabel(language: PromptLanguage, value: string): string {
  return language === 'zh-CN' ? `${value}（推荐）` : `${value} (Recommended)`
}

function question(label: string, fallback: string): string {
  return `${label} [${fallback}]: `
}

function selectOneInstruction(language: PromptLanguage): string {
  return choice(language, 'Up/Down to move, Enter to select.', '↑/↓ 移动，回车选择')
}

function selectManyInstruction(language: PromptLanguage): string {
  return choice(language, 'Up/Down to move, Space to toggle, Enter to confirm.', '↑/↓ 移动，空格勾选，回车确认')
}

function withSelectablePrompt<T>(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage,
  start: (
    render: (lines: string[]) => void,
    done: (error?: Error, value?: T, summary?: string) => void,
  ) => (value: string, key: Keypress) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let renderedRows = 0
    let finished = false
    const previousRawMode = input.isRaw

    if (!keypressEventsEnabled) {
      emitKeypressEvents(input)
      keypressEventsEnabled = true
    }

    // readline closes the interface on Ctrl+C unless the interface has a SIGINT
    // listener of its own, which would make the redraw cleanup below throw
    // ERR_USE_AFTER_CLOSE. Owning the event also makes the cancel path independent
    // of whether the keypress reaches the prompt handler.
    const onSigint = (): void => {
      done(cancelled(language))
    }

    const clear = (): void => {
      if (renderedRows === 0) return
      output.write(`\x1b[${renderedRows}F\x1b[0J`)
      renderedRows = 0
    }
    const render = (lines: string[]): void => {
      clear()
      // Move by the number of *physical* rows the terminal will show: the cursor-up
      // escape sequence counts rows, not logical lines, so long lines that wrap must
      // be counted after wrapping.
      const rows = lines.flatMap((line) => wrapToColumns(line, terminalColumns()))
      output.write(`${rows.join('\n')}\n`)
      renderedRows = rows.length
    }
    const cleanup = (): void => {
      input.off('keypress', onKeypress)
      for (const listener of suspended) input.on('keypress', listener)
      rl.off('SIGINT', onSigint)
      input.setRawMode(previousRawMode)
      output.write('\x1b[?25h')
      rl.resume()
    }
    const done = (error?: Error, value?: T, summary?: string): void => {
      if (finished) return
      finished = true
      clear()
      cleanup()
      if (summary) output.write(`${summary}\n`)
      if (error) reject(error)
      else resolve(value as T)
    }
    const onKeypress = start(render, done)

    // readline keeps its own keypress handler attached to the shared input stream.
    // Left in place it would echo characters typed here onto the screen and store them
    // in its line buffer, where the next rl.question() would consume them as an answer.
    // Suspend the foreign handlers for the lifetime of this prompt and restore them
    // afterwards so readline works normally again.
    const suspended = input.listeners('keypress') as ((...args: unknown[]) => void)[]
    for (const listener of suspended) input.off('keypress', listener)

    rl.on('SIGINT', onSigint)
    rl.pause()
    output.write('\x1b[?25l')
    input.setRawMode(true)
    input.resume()
    input.on('keypress', onKeypress)
  })
}

function terminalColumns(): number {
  const columns = (output as { columns?: number }).columns
  return typeof columns === 'number' && Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80
}

/** Closing punctuation that must not begin a wrapped row. */
const NO_ROW_START = /[、。，．：；！？）］｝〉》」』】〕…—～·%]/

/** Zero-width marker that records a legal break point inside a long CJK run. */
const BREAK_MARK = '\u200b'

export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += charWidth(char)
  return width
}

/**
 * Splits one logical prompt line into the physical rows a terminal of `columns`
 * width will actually use, so the redraw can move the cursor by the right count.
 * Wrapped continuations keep the original leading indentation.
 */
export function wrapToColumns(text: string, columns: number): string[] {
  if (columns < 2 || displayWidth(text) <= columns) return [text]
  const indent = /^[ \t]*/.exec(text)?.[0] ?? ''
  const limit = Math.max(1, columns - displayWidth(indent))
  const rows: string[] = []
  let row = ''
  let rowWidth = 0

  const flush = (): void => {
    rows.push(`${indent}${row.replaceAll(BREAK_MARK, '').trimEnd()}`)
    row = ''
    rowWidth = 0
  }

  // CJK text has no spaces, so allow a break after its punctuation: that keeps
  // "optimize-images、" together instead of splitting a word at the row edge.
  const body = text
    .slice(indent.length)
    .replace(/([、。，．：；！？）］｝〉》」』】〕…—～])(?=[^\s])/g, `$1${BREAK_MARK}`)

  for (const token of body.match(/\s+|\u200b|[^\s\u200b]+/g) ?? []) {
    if (token === BREAK_MARK) {
      row += token
      continue
    }
    const tokenWidth = displayWidth(token)
    if (/^\s+$/.test(token)) {
      if (rowWidth > 0 && rowWidth + tokenWidth <= limit) {
        row += token
        rowWidth += tokenWidth
      } else if (rowWidth > 0) {
        flush()
      }
      continue
    }
    if (rowWidth + tokenWidth <= limit) {
      row += token
      rowWidth += tokenWidth
      continue
    }
    if (rowWidth > 0) flush()
    if (tokenWidth <= limit) {
      row = token
      rowWidth = tokenWidth
      continue
    }
    // A single token longer than the row (typical for CJK text without spaces) is
    // hard-broken by display width.
    for (const char of token) {
      const width = charWidth(char)
      if (rowWidth > 0 && rowWidth + width > limit) {
        // Never start a row with trailing punctuation such as "、"; carry the
        // previous character down with it instead.
        let carry = ''
        if (row.length > 1 && NO_ROW_START.test(char)) {
          carry = row.slice(-1)
          row = row.slice(0, -1)
        }
        flush()
        row = carry
        rowWidth = displayWidth(carry)
      }
      row += char
      rowWidth += width
    }
  }
  if (row.replaceAll(BREAK_MARK, '').trim() !== '' || rows.length === 0) flush()
  return rows
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code === 0 || code === 0x200b || code === 0x200d) return 0
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  // Combining marks attach to the previous character.
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x20d0 && code <= 0x20f0) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  ) {
    return 0
  }
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  return wide ? 2 : 1
}

function isCancelKey(key: Keypress): boolean {
  return key.ctrl === true && key.name === 'c'
}

function controllerChoiceLabel(kind: ControllerKind, language: PromptLanguage): string {
  switch (kind) {
    case 'Adb':
      return choice(language, 'Android / Emulator (Adb)', 'Android / 模拟器（Adb）')
    case 'Win32':
      return choice(language, 'Windows app (Win32)', 'Windows 应用（Win32）')
    case 'MacOS':
      return choice(language, 'macOS app (MacOS)', 'macOS 应用（MacOS）')
    case 'PlayCover':
      return choice(language, 'PlayCover iOS app', 'PlayCover iOS 应用')
    case 'Gamepad':
      return choice(language, 'Gamepad (Windows)', 'Windows 手柄（Gamepad）')
    case 'WlRoots':
      return choice(language, 'wlroots app (Linux)', 'wlroots 应用（Linux）')
  }
}

async function isInsideGitTree(path: string): Promise<boolean> {
  let current = path
  for (;;) {
    if (await exists(join(current, '.git'))) return true
    const parent = resolve(current, '..')
    if (parent === current) return false
    current = parent
  }
}
