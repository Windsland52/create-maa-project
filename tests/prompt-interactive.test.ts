import { afterEach, describe, expect, it } from 'vitest'
import { resolveAddonDependencies } from '../src/addons.js'
import { parseArgs } from '../src/args.js'
import { runCli } from '../src/index.js'
import { REPOSITORY_FEATURE_ADDONS } from '../src/prompt.js'
import type { CliOptions } from '../src/types.js'
import {
  displayWidth,
  isPromptCancelled,
  linesForSelectMany,
  linesForSelectOne,
  PromptCancelledError,
  promptForCreateOptions,
  setupChoices,
  wrapToColumns,
} from '../src/prompt.js'

const ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g

type Harness = {
  output: () => string
  rows: () => string[]
  send: (name: string, sequence: string, ctrl?: boolean) => void
  enter: () => void
  down: () => void
  up: () => void
  space: () => void
  ctrlC: () => void
  type: (text: string) => void
  waitFor: (marker: string) => Promise<void>
  restore: () => void
}

const active: Harness[] = []

/**
 * Minimal TTY stand-in: readline keys off `isTTY`, and the prompt code writes the
 * redraw blocks to `process.stdout`, so patching those three properties is enough to
 * drive the real interactive code in-process.
 */
function createHarness(columns: number): Harness {
  const stdin = process.stdin as unknown as Record<string, unknown>
  const original = {
    stdinTTY: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY'),
    stdoutTTY: Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
    columns: Object.getOwnPropertyDescriptor(process.stdout, 'columns'),
    write: process.stdout.write,
    setRawMode: stdin.setRawMode,
    isRaw: stdin.isRaw,
  }
  const chunks: string[] = []

  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true })
  stdin.setRawMode = () => {}
  stdin.isRaw = false
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write

  const harness: Harness = {
    output: () => chunks.join(''),
    rows: () =>
      chunks
        .join('')
        .replace(ESCAPE, '')
        .split('\n')
        .filter((line) => line !== ''),
    send: (name, sequence, ctrl = false) => {
      process.stdin.emit('keypress', sequence, { name, sequence, ctrl })
    },
    enter: () => harness.send('return', '\r'),
    down: () => harness.send('down', '\u001b[B'),
    up: () => harness.send('up', '\u001b[A'),
    space: () => harness.send('space', ' '),
    ctrlC: () => harness.send('c', '\u0003', true),
    type: (text) => {
      for (const char of text) harness.send(char, char)
    },
    waitFor: async (marker) => {
      const deadline = Date.now() + 3000
      while (!harness.output().includes(marker)) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${JSON.stringify(marker)} in:\n${harness.output()}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    restore: () => {
      process.stdout.write = original.write
      if (original.stdinTTY) Object.defineProperty(process.stdin, 'isTTY', original.stdinTTY)
      if (original.stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', original.stdoutTTY)
      if (original.columns) Object.defineProperty(process.stdout, 'columns', original.columns)
      stdin.setRawMode = original.setRawMode
      stdin.isRaw = original.isRaw
    },
  }
  active.push(harness)
  return harness
}

afterEach(() => {
  while (active.length > 0) active.pop()?.restore()
  process.exitCode = 0
})

function promptOptions(): CliOptions {
  return parseArgs([
    '--lang',
    'en',
  ])
}

/** Answers every prompt in the default order and returns the resulting options. */
async function runInteractive(
  harness: Harness,
  answer: Partial<Record<'resource-pack' | 'git', string>> = {},
  setup: 'default' | 'custom' = 'default',
  featureKeys: string[] = [],
): Promise<CliOptions> {
  const options = promptOptions()
  const flow = promptForCreateOptions(options)

  await harness.waitFor('Project folder [')
  harness.enter()
  await harness.waitFor('Display name [')
  harness.enter()
  await harness.waitFor('Project type:')
  harness.enter()
  await harness.waitFor('License:')
  harness.enter()
  await harness.waitFor('Control targets:')
  harness.enter()
  await harness.waitFor('Setup:')
  if (setup === 'custom') {
    harness.down()
    harness.down()
    harness.enter()
    await harness.waitFor('Repository features:')
    for (const key of featureKeys) {
      if (key === 'down') harness.down()
      else if (key === 'up') harness.up()
      else harness.space()
    }
    harness.enter()
  } else {
    harness.enter()
  }
  await harness.waitFor('Add extra resource pack (')
  harness.send(answer['resource-pack'] === 'y' ? 'y' : 'n', answer['resource-pack'] === 'y' ? 'y' : 'n')
  if (answer['resource-pack'] === 'y') {
    await harness.waitFor('Resource pack folder [')
    harness.enter()
    await harness.waitFor('Resource pack display name [')
    harness.enter()
  }
  await harness.waitFor('Initialize Git repository (')
  harness.send(answer.git === 'y' ? 'y' : 'n', answer.git === 'y' ? 'y' : 'n')

  return flow
}

/** The final rendered menu for `label`, excluding the chosen-values summary that follows it. */
function lastMenuView(rendered: string, label: string): string {
  const header = `${label}:\n`
  const summaryIndex = rendered.lastIndexOf(`${label}: `)
  const end = summaryIndex === -1 ? rendered.length : summaryIndex
  return rendered.slice(rendered.lastIndexOf(header, end), end)
}

/**
 * Key sequence that walks the feature list to each named add-on and toggles it, so the tests
 * state which features they mean instead of hardcoding cursor offsets.
 */
function featureKeys(...addons: string[]): string[] {
  const keys: string[] = []
  let index = 0
  for (const addon of addons) {
    const target = REPOSITORY_FEATURE_ADDONS.indexOf(addon)
    if (target < 0) throw new Error(`unknown repository feature: ${addon}`)
    while (index < target) {
      keys.push('down')
      index += 1
    }
    while (index > target) {
      keys.push('up')
      index -= 1
    }
    keys.push('space')
  }
  return keys
}

describe('interactive prompt flow', () => {
  it('asks the core decisions in order and accepts single-key y/n answers', async () => {
    const harness = createHarness(80)
    const options = await runInteractive(harness, { 'resource-pack': 'y', git: 'n' })
    const output = harness.output()

    const order = [
      'Project folder [',
      'Display name [',
      'Project type:',
      'License:',
      'Control targets:',
      'Setup:',
      'Add extra resource pack (',
      'Initialize Git repository (',
    ]
    const positions = order.map((marker) => output.indexOf(marker))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))

    // A single "y" adds the resource pack; a single "n" leaves Git disabled.
    expect(options.add).toContain('resource-pack')
    expect(options.initializeGit).toBe(false)
    expect(output).toContain('Add extra resource pack: Yes')
    expect(output).toContain('Initialize Git repository: No')

    // The typed key must not be echoed onto the screen, and must not stay in readline's
    // line buffer where the following text questions would consume it as their answer.
    expect(harness.rows()).not.toContain('y')
    expect(options.resourcePackSlug).toBe('extra')
    expect(options.label).toBe('Extra')
  })

  it('shows a one-line description for every setup preset', async () => {
    const harness = createHarness(80)
    const flow = runInteractive(harness, { git: 'n' })
    await harness.waitFor('Setup:')
    harness.enter()

    await flow
    const output = harness.output()

    expect(output).toContain('Add dev tools, GitHub automation, and community files.')
    expect(output).toContain('Add no repository features.')
    expect(output).toContain('Choose repository features one by one.')
  })

  it('cancels quietly when Ctrl+C interrupts a free-text question', async () => {
    const harness = createHarness(80)
    const options = promptOptions()
    const flow = promptForCreateOptions(options)

    await harness.waitFor('Project folder [')
    harness.ctrlC()

    const error = await flow.then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(isPromptCancelled(error)).toBe(true)
    expect(error).toBeInstanceOf(PromptCancelledError)
    // readline's own "Aborted with Ctrl+C" must not leak to the user.
    expect((error as Error).message).not.toContain('Aborted')
  })

  it('cancels quietly when Ctrl+C interrupts a select prompt', async () => {
    const harness = createHarness(80)
    const options = promptOptions()
    const flow = promptForCreateOptions(options)

    await harness.waitFor('Project folder [')
    harness.enter()
    await harness.waitFor('Display name [')
    harness.enter()
    await harness.waitFor('Project type:')
    harness.ctrlC()

    const error = await flow.then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(isPromptCancelled(error)).toBe(true)
    // Before the SIGINT listener existed this threw ERR_USE_AFTER_CLOSE from the
    // redraw cleanup and crashed the process instead of cancelling.
    expect(harness.output()).not.toContain('ERR_USE_AFTER_CLOSE')
  })

  it('keeps every rendered row inside a narrow terminal and counts physical rows', async () => {
    // Narrow enough that the multi-select instruction and the preset summary must wrap;
    // at 60 columns every prompt now fits on its logical lines.
    const columns = 40
    const harness = createHarness(columns)
    await runInteractive(harness, { git: 'n' })

    const output = harness.output()
    for (const row of harness.rows()) {
      expect(displayWidth(row), `row wider than ${columns} columns: ${JSON.stringify(row)}`).toBeLessThanOrEqual(
        columns,
      )
    }

    // Every selectable prompt clears the screen once, so the cursor-up counts come in
    // prompt order: project type, license, control targets, setup, resource pack, git.
    const clears = [...output.matchAll(/\x1b\[(\d+)F\x1b\[0J/g)].map((match) => Number(match[1]))
    expect(clears).toHaveLength(6)

    // The control targets and setup blocks wrap, so their counts prove the cleanup moved
    // by physical rows instead of logical lines.
    const rowsFor = (lines: string[]): number => lines.flatMap((line) => wrapToColumns(line, columns)).length
    const targetLines = linesForSelectMany(
      'en',
      'Control targets',
      [
        { value: 'Adb', label: 'Android / Emulator (Adb)' },
        { value: 'Win32', label: 'Windows app (Win32)' },
        { value: 'MacOS', label: 'macOS app (MacOS)' },
        { value: 'PlayCover', label: 'PlayCover iOS app' },
        { value: 'Gamepad', label: 'Gamepad (Windows)' },
        { value: 'WlRoots', label: 'wlroots app (Linux)' },
      ],
      0,
      new Set(['Adb']),
      { requireOne: true },
    )
    const setupLines = linesForSelectOne('en', 'Setup', setupChoices('en'), 0)

    expect(rowsFor(targetLines)).toBeGreaterThan(targetLines.length)
    expect(rowsFor(setupLines)).toBeGreaterThan(setupLines.length)
    expect(clears[2]).toBe(rowsFor(targetLines))
    expect(clears[3]).toBe(rowsFor(setupLines))

    // The confirmation prompts fit on one row, so their counts match their logical lines.
    expect(clears[4]).toBe(1)
    expect(clears[5]).toBe(1)
  })

  it('keeps long multi-select lines narrow by moving the required hint to its own row', () => {
    const lines = linesForSelectMany<string>('en', 'Control targets', [], 0, new Set<string>(), { requireOne: true })

    expect(lines.at(-1)).toBe('  At least one required.')
    expect(lines.some((line) => line.includes('(At least one required.)'))).toBe(false)
  })

  it('checks required features and clears dependents so the checkboxes match the result', async () => {
    const harness = createHarness(80)
    // Start from Custom, clear dev-tools and github, then select git-cliff (which needs both).
    const options = await runInteractive(
      harness,
      { git: 'n' },
      'custom',
      featureKeys('dev-tools', 'github', 'git-cliff'),
    )

    // Before the dependency-aware toggling this returned only ['git-cliff'] while creation
    // silently enabled dev-tools and github.
    expect(options.add).toEqual([
      'dev-tools',
      'github',
      'git-cliff',
    ])
    expect(resolveAddonDependencies(options.add)).toEqual(options.add)

    const rendered = harness.output().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    const lastView = lastMenuView(rendered, 'Repository features')
    expect(lastView).toContain('[x] dev-tools')
    expect(lastView).toContain('[x] github')
    expect(lastView).toContain('[x] git-cliff')
    // vscode was enabled by the initial selection and cleared with its dev-tools dependency.
    expect(lastView).toContain('[ ] vscode')
  })

  it('clears features that depend on a feature the user turns off', async () => {
    const harness = createHarness(80)
    // Select git-cliff, then clear github: git-cliff cannot stay enabled without it.
    const options = await runInteractive(harness, { git: 'n' }, 'custom', featureKeys('git-cliff', 'github'))

    expect(options.add).toEqual([
      'dev-tools',
      'vscode',
    ])
    const rendered = harness.output().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    const lastView = lastMenuView(rendered, 'Repository features')
    expect(lastView).toContain('[ ] git-cliff')
    expect(lastView).toContain('[x] dev-tools')
    expect(lastView).toContain('[x] vscode')
  })

  it('indents the feature list by dependency depth', async () => {
    const harness = createHarness(80)
    const options = await runInteractive(harness, { git: 'n' }, 'custom', [])

    const rendered = harness.output().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    const view = lastMenuView(rendered, 'Repository features')
    const lines = view.split('\n')
    const checkboxColumn = (addon: string): number => {
      const line = lines.find((candidate) => candidate.includes(addon)) ?? ''
      const marker = line.indexOf('[x]')
      return marker === -1 ? line.indexOf('[ ]') : marker
    }

    // One indent level is two columns and applies before the checkbox, so deeper features
    // line up under the feature they depend on.
    expect(checkboxColumn('dev-tools')).toBe(2)
    expect(checkboxColumn('github')).toBe(4)
    expect(checkboxColumn('vscode')).toBe(4)
    expect(checkboxColumn('git-cliff')).toBe(6)
    expect(lines.find((line) => line.includes('dev-tools'))).toMatch(/^[> ] \[x\] dev-tools$/)
    // Editor integration stays in the interactive default, matching the previous behaviour.
    // The result follows the rendered list order, so the sibling vscode precedes github.
    expect(options.add).toEqual([
      'dev-tools',
      'vscode',
      'github',
    ])
  })

  it('exits with 130 and prints no error line when the whole CLI run is cancelled', async () => {
    const harness = createHarness(80)
    const previousAutoUpdate = process.env.CREATE_MAA_PROJECT_AUTO_UPDATE
    const originalError = process.stderr.write
    const errors: string[] = []
    process.env.CREATE_MAA_PROJECT_AUTO_UPDATE = '0'
    process.stderr.write = ((chunk: string) => {
      errors.push(String(chunk))
      return true
    }) as typeof process.stderr.write

    try {
      const exitCode = runCli(['--lang', 'en'])
      await harness.waitFor('Project folder [')
      harness.ctrlC()

      // Interrupt convention: quiet 130 instead of "Error: 已取消交互。" on exit code 1.
      expect(await exitCode).toBe(130)
    } finally {
      process.stderr.write = originalError
      if (previousAutoUpdate === undefined) delete process.env.CREATE_MAA_PROJECT_AUTO_UPDATE
      else process.env.CREATE_MAA_PROJECT_AUTO_UPDATE = previousAutoUpdate
    }

    const stderr = errors.join('')
    expect(stderr).not.toContain('Error:')
    expect(stderr).not.toContain('Aborted')
    expect(harness.output()).not.toContain('Error:')
  })
})
