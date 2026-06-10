import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { join, resolve } from 'node:path'
import type { CliOptions, ControllerKind, LicenseKind } from './types.js'
import { exists, normalizeSlug } from './utils.js'

export async function promptForCreateOptions(options: CliOptions): Promise<CliOptions> {
    if (options.noInteractive || !process.stdin.isTTY || !process.stdout.isTTY) return options
    if (
        options.name &&
        options.displayName &&
        options.controller &&
        options.license &&
        options.initializeGit !== undefined
    ) {
        return options
    }

    const rl = createInterface({ input, output })
    try {
        let rawProjectName = options.name
        if (!options.name) {
            const answer = await rl.question('Project slug or directory [maa-project]: ')
            rawProjectName = answer.trim() || 'maa-project'
            options.name = rawProjectName
        }
        const inferredSlug = normalizeSlug(options.name)
        if (!inferredSlug) {
            options.slug = await askAsciiSlug(rl)
        } else if (options.name !== inferredSlug) {
            output.write(`Using project slug: ${inferredSlug}\n`)
            options.slug = inferredSlug
        } else {
            options.slug = inferredSlug
        }
        if (!options.displayName) {
            const fallbackDisplayName = rawProjectName ?? options.name
            const answer = await rl.question(`Display name [${fallbackDisplayName}]: `)
            options.displayName = answer.trim() || fallbackDisplayName
        }
        if (!options.controller) {
            options.controller = await choice<ControllerKind>(rl, 'Controller', ['ADB', 'Win32', 'None'], 'ADB')
        }
        if (!options.license) {
            options.license = await choice<LicenseKind>(
                rl,
                'License',
                ['AGPL-3.0-or-later', 'MIT', 'None'],
                'AGPL-3.0-or-later'
            )
        }
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

async function askAsciiSlug(rl: ReturnType<typeof createInterface>): Promise<string> {
    for (;;) {
        const answer = await rl.question('ASCII project slug [maa-project]: ')
        const raw = answer.trim()
        if (!raw) return 'maa-project'
        const slug = normalizeSlug(raw)
        if (slug) {
            if (slug !== raw) output.write(`Using project slug: ${slug}\n`)
            return slug
        }
        output.write('Project slug must contain ASCII letters, numbers, or hyphens.\n')
    }
}

async function choice<T extends string>(
    rl: ReturnType<typeof createInterface>,
    label: string,
    values: T[],
    fallback: T
): Promise<T> {
    const answer = await rl.question(`${label} (${values.join('/')}) [${fallback}]: `)
    const value = answer.trim() || fallback
    if (!values.includes(value as T)) {
        throw new Error(`${label} must be one of: ${values.join(', ')}`)
    }
    return value as T
}

async function yesNo(
    rl: ReturnType<typeof createInterface>,
    label: string,
    fallback: boolean
): Promise<boolean> {
    const answer = await rl.question(`${label} (yes/no) [${fallback ? 'yes' : 'no'}]: `)
    const value = answer.trim().toLowerCase()
    if (!value) return fallback
    if (value === 'yes' || value === 'y') return true
    if (value === 'no' || value === 'n') return false
    throw new Error(`${label} must be yes or no`)
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
