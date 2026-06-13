import { createInterface } from 'node:readline/promises'
import { emitKeypressEvents } from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import { join, resolve } from 'node:path'
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
    zhCN: '添加额外资源包 Add extra resource pack'
  },
  atLeastOneRequired: {
    en: 'At least one required.',
    zhCN: '至少选择一项。 At least one required.'
  },
  controlTargets: {
    en: 'Control targets',
    zhCN: '控制目标 Control targets'
  },
  custom: {
    en: 'Custom',
    zhCN: '自定义 Custom'
  },
  displayName: {
    en: 'Display name',
    zhCN: '显示名称 Display name'
  },
  initializeGitRepository: {
    en: 'Initialize Git repository',
    zhCN: '初始化 Git 仓库 Initialize Git repository'
  },
  license: {
    en: 'License',
    zhCN: '许可证 License'
  },
  minimal: {
    en: 'Minimal',
    zhCN: '最小 Minimal'
  },
  no: {
    en: 'No',
    zhCN: '否 No'
  },
  noLicense: {
    en: 'No license',
    zhCN: '无许可证 No license'
  },
  none: {
    en: 'none',
    zhCN: '无 none'
  },
  promptCancelled: {
    en: 'Prompt cancelled.',
    zhCN: '已取消交互。 Prompt cancelled.'
  },
  projectFolder: {
    en: 'Project folder',
    zhCN: '项目目录 Project folder'
  },
  projectId: {
    en: 'Project ID',
    zhCN: '项目 ID Project ID'
  },
  projectIdAsciiOnly: {
    en: 'Project ID must contain ASCII letters, numbers, or hyphens.',
    zhCN: '项目 ID 只能包含 ASCII 字母、数字或连字符。 Project ID must contain ASCII letters, numbers, or hyphens.'
  },
  projectType: {
    en: 'Project type',
    zhCN: '项目类型 Project type'
  },
  recommended: {
    en: 'Recommended',
    zhCN: '推荐 Recommended'
  },
  repositoryFeatures: {
    en: 'Repository features',
    zhCN: '仓库功能 Repository features'
  },
  resourcePackDisplayName: {
    en: 'Resource pack display name',
    zhCN: '资源包显示名称 Resource pack display name'
  },
  resourcePackFolder: {
    en: 'Resource pack folder',
    zhCN: '资源包目录 Resource pack folder'
  },
  resourcePackFolderAsciiOnly: {
    en: 'Resource pack folder must contain ASCII letters, numbers, or hyphens.',
    zhCN: '资源包目录只能包含 ASCII 字母、数字或连字符。 Resource pack folder must contain ASCII letters, numbers, or hyphens.'
  },
  selectAtLeastOneItem: {
    en: 'Select at least one item.',
    zhCN: '请至少选择一项。 Select at least one item.'
  },
  setup: {
    en: 'Setup',
    zhCN: '仓库配置 Setup'
  },
  setupAll: {
    en: 'All',
    zhCN: '全部 All'
  },
  usingProjectId: {
    en: 'Using project ID',
    zhCN: '使用项目 ID Using project ID'
  },
  yes: {
    en: 'Yes',
    zhCN: '是 Yes'
  }
} satisfies Record<string, LocalizedText>

export async function promptForCreateOptions(options: CliOptions): Promise<CliOptions> {
  if (options.noInteractive || !process.stdin.isTTY || !process.stdout.isTTY) return options

  const language = resolvePromptLanguage(options.lang)
  const rl = createInterface({ input, output })
  try {
    let rawProjectName = options.name
    if (!options.name) {
      const answer = await rl.question(question(label(language, TEXT.projectFolder), 'maa-project'))
      rawProjectName = answer.trim() || 'maa-project'
      options.name = rawProjectName
    }
    const inferredSlug = normalizeSlug(options.name)
    if (!inferredSlug) {
      options.slug = await askAsciiProjectId(rl, language)
    } else if (options.name !== inferredSlug) {
      output.write(`${label(language, TEXT.usingProjectId)}: ${inferredSlug}\n`)
      options.slug = inferredSlug
    } else {
      options.slug = inferredSlug
    }
    if (!options.displayName) {
      const fallbackDisplayName = rawProjectName ?? options.name
      const answer = await rl.question(
        question(label(language, TEXT.displayName), fallbackDisplayName)
      )
      options.displayName = answer.trim() || fallbackDisplayName
    }
    if (!options.license) {
      options.license = await selectOne<LicenseKind>(
        rl,
        language,
        label(language, TEXT.license),
        [
          {
            value: 'AGPL-3.0-or-later',
            label: recommendedLabel(language, 'AGPL-3.0-or-later')
          },
          { value: 'MIT', label: 'MIT' },
          { value: 'None', label: label(language, TEXT.noLicense) }
        ],
        'AGPL-3.0-or-later'
      )
    }
    if (!options.controllers?.length) {
      options.controllers = await controllerMultiChoice(rl, language)
    }
    if (!options.explicitTemplate) {
      options.template = await selectOne<TemplateName>(
        rl,
        language,
        label(language, TEXT.projectType),
        [
          { value: 'pipeline', label: choice(language, 'Pipeline', '流水线 Pipeline') },
          {
            value: 'agent',
            label: choice(language, 'Pipeline + Python Agent', '流水线 + Python Agent')
          }
        ],
        'pipeline'
      )
    }
    if (options.add.length === 0) {
      const setup = await selectOne<SetupPreset>(
        rl,
        language,
        label(language, TEXT.setup),
        [
          { value: 'all', label: recommendedLabel(language, label(language, TEXT.setupAll)) },
          { value: 'minimal', label: label(language, TEXT.minimal) },
          { value: 'custom', label: label(language, TEXT.custom) }
        ],
        'all'
      )
      options.add = setupAddons(setup, options.add)
      if (setup === 'custom') {
        options.add = addUnique(options.add, await customRepositoryFeatures(rl, language))
      }
    }
    await promptForResourcePack(rl, options, language)
    if (options.initializeGit === undefined) {
      const targetRoot = resolve(process.cwd(), options.name ?? '.')
      const parentHasGit = await isInsideGitTree(resolve(targetRoot, '..'))
      options.initializeGit = await yesNo(
        rl,
        language,
        label(language, TEXT.initializeGitRepository),
        !parentHasGit
      )
    }
    return options
  } finally {
    rl.close()
  }
}

async function askAsciiProjectId(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage
): Promise<string> {
  for (;;) {
    const answer = await rl.question(question(label(language, TEXT.projectId), 'maa-project'))
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
  language: PromptLanguage
): Promise<ControllerKind[]> {
  return selectMany<ControllerKind>(
    rl,
    language,
    label(language, TEXT.controlTargets),
    CONTROLLER_KINDS.map((kind) => ({
      value: kind,
      label: controllerChoiceLabel(kind, language)
    })),
    DEFAULT_CONTROLLER_KINDS,
    { requireOne: true }
  )
}

export function setupAddons(setup: SetupPreset, current: string[]): string[] {
  if (setup === 'minimal') return current
  if (setup === 'all')
    return addUnique(current, [
      'dev-tools',
      'github',
      'git-cliff',
      'auto-format',
      'optimize-images',
      'schema-sync',
      'community'
    ])
  return current
}

async function customRepositoryFeatures(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage
): Promise<string[]> {
  return selectMany<string>(
    rl,
    language,
    label(language, TEXT.repositoryFeatures),
    [
      { value: 'dev-tools', label: 'dev-tools' },
      { value: 'github', label: '  github' },
      { value: 'git-cliff', label: '    git-cliff' },
      { value: 'auto-format', label: '    auto-format' },
      { value: 'optimize-images', label: '    optimize-images' },
      { value: 'schema-sync', label: '    schema-sync' },
      { value: 'community', label: '    community' }
    ],
    [
      'dev-tools',
      'github'
    ]
  )
}

async function promptForResourcePack(
  rl: ReturnType<typeof createInterface>,
  options: CliOptions,
  language: PromptLanguage
): Promise<void> {
  if (!options.add.includes('resource-pack')) {
    const addResourcePack = await confirm(
      rl,
      language,
      label(language, TEXT.addExtraResourcePack),
      false
    )
    if (!addResourcePack) return
    options.add = addUnique(options.add, [
      'resource-pack'
    ])
  }
  if (!options.resourcePackSlug) {
    options.resourcePackSlug = await askResourcePackFolder(rl, language)
  }
  if (!options.label) {
    const fallback = displayNameFromFolder(options.resourcePackSlug)
    const answer = await rl.question(
      question(label(language, TEXT.resourcePackDisplayName), fallback)
    )
    options.label = answer.trim() || fallback
  }
}

async function askResourcePackFolder(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage
): Promise<string> {
  for (;;) {
    const answer = await rl.question(question(label(language, TEXT.resourcePackFolder), 'extra'))
    const slug = normalizeSlug(answer.trim() || 'extra')
    if (slug) return slug
    output.write(`${label(language, TEXT.resourcePackFolderAsciiOnly)}\n`)
  }
}

function addUnique(existing: string[], values: string[]): string[] {
  const set = new Set(existing)
  for (const value of values) set.add(value)
  return [
    ...set
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
  fallback: boolean
): Promise<boolean> {
  return confirm(rl, language, label, fallback)
}

type Choice<T extends string> = {
  value: T
  label: string
}

type Keypress = {
  ctrl?: boolean
  name?: string
  sequence?: string
}

let keypressEventsEnabled = false

async function confirm(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage,
  label: string,
  fallback: boolean
): Promise<boolean> {
  return selectOne<BooleanChoice>(
    rl,
    language,
    label,
    [
      { value: 'yes', label: labelText(language, TEXT.yes) },
      { value: 'no', label: labelText(language, TEXT.no) }
    ],
    fallback ? 'yes' : 'no'
  ).then((value) => value === 'yes')
}

type BooleanChoice = 'yes' | 'no'

async function selectOne<T extends string>(
  rl: ReturnType<typeof createInterface>,
  language: PromptLanguage,
  label: string,
  choices: Choice<T>[],
  fallback: T
): Promise<T> {
  if (choices.length === 0) throw new Error(`${label} has no choices.`)
  let index = Math.max(
    0,
    choices.findIndex((choice) => choice.value === fallback)
  )
  return withSelectablePrompt(rl, (render, done) => {
    const onKeypress = (_value: string, key: Keypress): void => {
      if (isCancelKey(key)) {
        done(new Error(labelText(language, TEXT.promptCancelled)))
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
  options: { requireOne?: boolean } = {}
): Promise<T[]> {
  if (choices.length === 0) throw new Error(`${label} has no choices.`)
  let index = 0
  const selected = new Set<T>(fallback)
  return withSelectablePrompt(rl, (render, done) => {
    const onKeypress = (_value: string, key: Keypress): void => {
      if (isCancelKey(key)) {
        done(new Error(labelText(language, TEXT.promptCancelled)))
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
              labelText(language, TEXT.selectAtLeastOneItem)
            )
          )
          return
        }
        done(
          undefined,
          values,
          `${label}: ${values.length > 0 ? values.join(', ') : labelText(language, TEXT.none)}`
        )
      }
    }
    render(linesForSelectMany(language, label, choices, index, selected, options))
    return onKeypress
  })
}

function linesForSelectOne<T extends string>(
  language: PromptLanguage,
  label: string,
  choices: Choice<T>[],
  index: number
): string[] {
  return [
    `${label}:`,
    ...choices.map((choice, choiceIndex) => `${choiceIndex === index ? '>' : ' '} ${choice.label}`),
    `  ${selectOneInstruction(language)}`
  ]
}

function linesForSelectMany<T extends string>(
  language: PromptLanguage,
  label: string,
  choices: Choice<T>[],
  index: number,
  selected: Set<T>,
  options: { requireOne?: boolean },
  message?: string
): string[] {
  return [
    `${label}:`,
    ...choices.map((choice, choiceIndex) => {
      const checked = selected.has(choice.value) ? '[x]' : '[ ]'
      return `${choiceIndex === index ? '>' : ' '} ${checked} ${choice.label}`
    }),
    `  ${selectManyInstruction(language)}${options.requireOne ? ` ${labelText(language, TEXT.atLeastOneRequired)}` : ''}`,
    ...(message ? [
          `  ${message}`
        ] : [])
  ]
}

function label(language: PromptLanguage, text: LocalizedText): string {
  return labelText(language, text)
}

function labelText(language: PromptLanguage, text: LocalizedText): string {
  return language === 'zh-CN' ? text.zhCN : text.en
}

function choice(language: PromptLanguage, english: string, zhCN: string): string {
  return language === 'zh-CN' ? zhCN : english
}

function recommendedLabel(language: PromptLanguage, value: string): string {
  return `${value} (${labelText(language, TEXT.recommended)})`
}

function question(label: string, fallback: string): string {
  return `${label} [${fallback}]: `
}

function selectOneInstruction(language: PromptLanguage): string {
  return choice(
    language,
    'Up/Down to move, Enter to select.',
    '上/下移动 Up/Down，回车选择 Enter to select.'
  )
}

function selectManyInstruction(language: PromptLanguage): string {
  return choice(
    language,
    'Up/Down to move, Space to toggle, Enter to confirm.',
    '上/下移动 Up/Down，空格切换 Space，回车确认 Enter to confirm.'
  )
}

function withSelectablePrompt<T>(
  rl: ReturnType<typeof createInterface>,
  start: (
    render: (lines: string[]) => void,
    done: (error?: Error, value?: T, summary?: string) => void
  ) => (value: string, key: Keypress) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let renderedLines = 0
    let finished = false
    const previousRawMode = input.isRaw

    if (!keypressEventsEnabled) {
      emitKeypressEvents(input)
      keypressEventsEnabled = true
    }

    const clear = (): void => {
      if (renderedLines === 0) return
      output.write(`\x1b[${renderedLines}F\x1b[0J`)
      renderedLines = 0
    }
    const render = (lines: string[]): void => {
      clear()
      output.write(`${lines.join('\n')}\n`)
      renderedLines = lines.length
    }
    const cleanup = (): void => {
      input.off('keypress', onKeypress)
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

    rl.pause()
    output.write('\x1b[?25l')
    input.setRawMode(true)
    input.resume()
    input.on('keypress', onKeypress)
  })
}

function isCancelKey(key: Keypress): boolean {
  return key.ctrl === true && key.name === 'c'
}

function controllerChoiceLabel(kind: ControllerKind, language: PromptLanguage): string {
  switch (kind) {
    case 'Adb':
      return choice(
        language,
        'Android / Emulator (Adb)',
        'Android / 模拟器 Android / Emulator (Adb)'
      )
    case 'Win32':
      return choice(language, 'Windows app (Win32)', 'Windows 应用 Windows app (Win32)')
    case 'MacOS':
      return choice(language, 'macOS app (MacOS)', 'macOS 应用 macOS app (MacOS)')
    case 'PlayCover':
      return choice(language, 'PlayCover iOS app', 'PlayCover iOS 应用 PlayCover iOS app')
    case 'Gamepad':
      return choice(language, 'Gamepad (Windows)', '手柄 Gamepad (Windows)')
    case 'WlRoots':
      return choice(language, 'wlroots app (Linux)', 'wlroots 应用 wlroots app (Linux)')
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
