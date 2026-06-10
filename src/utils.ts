import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export function stableJson(value: unknown): string {
    return `${JSON.stringify(sortJson(value), null, 4)}\n`
}

export function prettyJson(value: unknown): string {
    return `${JSON.stringify(value, null, 4)}\n`
}

function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortJson)
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        const sorted: Record<string, unknown> = {}
        for (const key of Object.keys(record).sort()) {
            sorted[key] = sortJson(record[key])
        }
        return sorted
    }
    return value
}

export function sha256(text: string | Buffer): string {
    return createHash('sha256').update(text).digest('hex')
}

export async function exists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

export async function writeText(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
}

export async function readText(path: string): Promise<string> {
    return readFile(path, 'utf8')
}

export function nowIso(): string {
    return new Date().toISOString()
}

export function normalizeSlug(input: string): string {
    return input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
}

export function assertValidSlug(slug: string): void {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,212}[a-z0-9])?$/.test(slug)) {
        throw new Error(
            `Invalid project slug "${slug}". Use lowercase ASCII letters, numbers, and hyphens.`
        )
    }
}

export function stripV(version: string): string {
    return version.replace(/^v/i, '')
}

export function addV(version: string): string {
    return version.startsWith('v') ? version : `v${version}`
}
