import { createInterface } from 'node:readline/promises'
import { emitKeypressEvents } from 'node:readline'
import { stdin as input, stdout as output } from 'node:process'
import { join, resolve } from 'node:path'
import type { CliOptions, ControllerKind, LicenseKind, TemplateName } from './types.js'
import { exists, normalizeSlug } from './utils.js'
import { CONTROLLER_KINDS, DEFAULT_CONTROLLER_KINDS } from './controllers.js'

type SetupPreset = 'all' | 'minimal' | 'custom'

export async function promptForCreateOptions(options: CliOptions): Promise<CliOptions> {
    if (options.noInteractive || !process.stdin.isTTY || !process.stdout.isTTY) return options

    const rl = createInterface({ input, output })
    try {
        let rawProjectName = options.name
        if (!options.name) {
            const answer = await rl.question('Project folder [maa-project]: ')
            rawProjectName = answer.trim() || 'maa-project'
            options.name = rawProjectName
        }
        const inferredSlug = normalizeSlug(options.name)
        if (!inferredSlug) {
            options.slug = await askAsciiProjectId(rl)
        } else if (options.name !== inferredSlug) {
            output.write(`Using project ID: ${inferredSlug}\n`)
            options.slug = inferredSlug
        } else {
            options.slug = inferredSlug
        }
        if (!options.displayName) {
            const fallbackDisplayName = rawProjectName ?? options.name
            const answer = await rl.question(`Display name [${fallbackDisplayName}]: `)
            options.displayName = answer.trim() || fallbackDisplayName
        }
        if (!options.license) {
            options.license = await selectOne<LicenseKind>(
                rl,
                'License',
                [
                    { value: 'AGPL-3.0-or-later', label: 'AGPL-3.0-or-later (Recommended)' },
                    { value: 'MIT', label: 'MIT' },
                    { value: 'None', label: 'No license' }
                ],
                'AGPL-3.0-or-later'
            )
        }
        if (!options.controllers?.length) {
            options.controllers = await controllerMultiChoice(rl)
        }
        if (!options.explicitTemplate) {
            options.template = await selectOne<TemplateName>(
                rl,
                'Project type',
                [
                    { value: 'pipeline', label: 'Pipeline' },
                    { value: 'agent', label: 'Pipeline + Python Agent' }
                ],
                'pipeline'
            )
        }
        if (options.add.length === 0) {
            const setup = await selectOne<SetupPreset>(
                rl,
                'Setup',
                [
                    { value: 'all', label: 'All (Recommended)' },
                    { value: 'minimal', label: 'Minimal' },
                    { value: 'custom', label: 'Custom' }
                ],
                'all'
            )
            options.add = setupAddons(setup, options.add)
            if (setup === 'custom') {
                options.add = addUnique(options.add, await customRepositoryFeatures(rl))
            }
        }
        await promptForResourcePack(rl, options)
        if (options.initializeGit === undefined) {
            const targetRoot = resolve(process.cwd(), options.name ?? '.')
            const parentHasGit = await isInsideGitTree(resolve(targetRoot, '..'))
            options.initializeGit = await yesNo(rl, 'Initialize Git repository', !parentHasGit)
        }
        return options
    } finally {
        rl.close()
    }
}

async function askAsciiProjectId(rl: ReturnType<typeof createInterface>): Promise<string> {
    for (;;) {
        const answer = await rl.question('Project ID [maa-project]: ')
        const raw = answer.trim()
        if (!raw) return 'maa-project'
        const slug = normalizeSlug(raw)
        if (slug) {
            if (slug !== raw) output.write(`Using project ID: ${slug}\n`)
            return slug
        }
        output.write('Project ID must contain ASCII letters, numbers, or hyphens.\n')
    }
}

async function controllerMultiChoice(rl: ReturnType<typeof createInterface>): Promise<ControllerKind[]> {
    return selectMany<ControllerKind>(
        rl,
        'Control targets',
        CONTROLLER_KINDS.map((kind) => ({
            value: kind,
            label: controllerChoiceLabel(kind)
        })),
        DEFAULT_CONTROLLER_KINDS,
        { requireOne: true }
    )
}

function setupAddons(setup: SetupPreset, current: string[]): string[] {
    if (setup === 'minimal') return current
    if (setup === 'all') return addUnique(current, ['dev-tools', 'github', 'git-cliff', 'schema-sync', 'community'])
    return current
}

async function customRepositoryFeatures(rl: ReturnType<typeof createInterface>): Promise<string[]> {
    return selectMany<string>(
        rl,
        'Repository features',
        [
            { value: 'dev-tools', label: 'dev-tools' },
            { value: 'github', label: '  github' },
            { value: 'git-cliff', label: '    git-cliff' },
            { value: 'auto-format', label: '    auto-format' },
            { value: 'optimize-images', label: '    optimize-images' },
            { value: 'schema-sync', label: '    schema-sync' },
            { value: 'community', label: '    community' }
        ],
        ['dev-tools', 'github']
    )
}

async function promptForResourcePack(
    rl: ReturnType<typeof createInterface>,
    options: CliOptions
): Promise<void> {
    if (!options.add.includes('resource-pack')) {
        const addResourcePack = await confirm(rl, 'Add extra resource pack', false)
        if (!addResourcePack) return
        options.add = addUnique(options.add, ['resource-pack'])
    }
    if (!options.resourcePackSlug) {
        options.resourcePackSlug = await askResourcePackFolder(rl)
    }
    if (!options.label) {
        const fallback = displayNameFromFolder(options.resourcePackSlug)
        const answer = await rl.question(`Resource pack display name [${fallback}]: `)
        options.label = answer.trim() || fallback
    }
}

async function askResourcePackFolder(rl: ReturnType<typeof createInterface>): Promise<string> {
    for (;;) {
        const answer = await rl.question('Resource pack folder [extra]: ')
        const slug = normalizeSlug(answer.trim() || 'extra')
        if (slug) return slug
        output.write('Resource pack folder must contain ASCII letters, numbers, or hyphens.\n')
    }
}

function addUnique(existing: string[], values: string[]): string[] {
    const set = new Set(existing)
    for (const value of values) set.add(value)
    return [...set]
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
    label: string,
    fallback: boolean
): Promise<boolean> {
    return confirm(rl, label, fallback)
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
    label: string,
    fallback: boolean
): Promise<boolean> {
    return selectOne<BooleanChoice>(
        rl,
        label,
        [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' }
        ],
        fallback ? 'yes' : 'no'
    ).then((value) => value === 'yes')
}

type BooleanChoice = 'yes' | 'no'

async function selectOne<T extends string>(
    rl: ReturnType<typeof createInterface>,
    label: string,
    choices: Choice<T>[],
    fallback: T
): Promise<T> {
    if (choices.length === 0) throw new Error(`${label} has no choices.`)
    let index = Math.max(0, choices.findIndex((choice) => choice.value === fallback))
    return withSelectablePrompt(rl, (render, done) => {
        const onKeypress = (_value: string, key: Keypress): void => {
            if (isCancelKey(key)) {
                done(new Error('Prompt cancelled.'))
                return
            }
            if (key.name === 'up' || key.name === 'k') {
                index = (index - 1 + choices.length) % choices.length
                render(linesForSelectOne(label, choices, index))
                return
            }
            if (key.name === 'down' || key.name === 'j') {
                index = (index + 1) % choices.length
                render(linesForSelectOne(label, choices, index))
                return
            }
            if (key.name === 'return' || key.name === 'enter') {
                done(undefined, choices[index]?.value, `${label}: ${choices[index]?.label ?? ''}`)
            }
        }
        render(linesForSelectOne(label, choices, index))
        return onKeypress
    })
}

async function selectMany<T extends string>(
    rl: ReturnType<typeof createInterface>,
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
                done(new Error('Prompt cancelled.'))
                return
            }
            if (key.name === 'up' || key.name === 'k') {
                index = (index - 1 + choices.length) % choices.length
                render(linesForSelectMany(label, choices, index, selected, options))
                return
            }
            if (key.name === 'down' || key.name === 'j') {
                index = (index + 1) % choices.length
                render(linesForSelectMany(label, choices, index, selected, options))
                return
            }
            if (key.name === 'space' || key.sequence === ' ') {
                const value = choices[index]?.value
                if (value) {
                    if (selected.has(value)) selected.delete(value)
                    else selected.add(value)
                }
                render(linesForSelectMany(label, choices, index, selected, options))
                return
            }
            if (key.name === 'return' || key.name === 'enter') {
                const values = choices.map((choice) => choice.value).filter((value) => selected.has(value))
                if (options.requireOne && values.length === 0) {
                    render(linesForSelectMany(label, choices, index, selected, options, 'Select at least one item.'))
                    return
                }
                done(undefined, values, `${label}: ${values.length > 0 ? values.join(', ') : 'none'}`)
            }
        }
        render(linesForSelectMany(label, choices, index, selected, options))
        return onKeypress
    })
}

function linesForSelectOne<T extends string>(label: string, choices: Choice<T>[], index: number): string[] {
    return [
        `${label}:`,
        ...choices.map((choice, choiceIndex) => `${choiceIndex === index ? '>' : ' '} ${choice.label}`),
        '  Up/Down to move, Enter to select.'
    ]
}

function linesForSelectMany<T extends string>(
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
        `  Up/Down to move, Space to toggle, Enter to confirm.${options.requireOne ? ' At least one required.' : ''}`,
        ...(message ? [`  ${message}`] : [])
    ]
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

function controllerChoiceLabel(kind: ControllerKind): string {
    switch (kind) {
        case 'Adb':
            return 'Android / Emulator (Adb)'
        case 'Win32':
            return 'Windows app (Win32)'
        case 'MacOS':
            return 'macOS app (MacOS)'
        case 'PlayCover':
            return 'PlayCover iOS app'
        case 'Gamepad':
            return 'Gamepad (Windows)'
        case 'WlRoots':
            return 'wlroots app (Linux)'
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
