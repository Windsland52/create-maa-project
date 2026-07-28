import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

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

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'The operation was aborted.')
  error.name = 'AbortError'
  throw error
}

export async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

export async function writeFileAtomic(path: string, content: string | Buffer): Promise<void> {
  await replaceFileAtomically(path, async (temporaryPath) => {
    if (typeof content === 'string') await writeFile(temporaryPath, content, 'utf8')
    else await writeFile(temporaryPath, content)
  })
}

export async function copyFileAtomic(source: string, target: string): Promise<void> {
  await replaceFileAtomically(target, (temporaryPath) => copyFile(source, temporaryPath))
}

async function replaceFileAtomically(path: string, write: (temporaryPath: string) => Promise<void>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await write(temporaryPath)
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
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
    throw new Error(`Invalid project ID "${slug}". Use lowercase ASCII letters, numbers, and hyphens.`)
  }
}

export function stripV(version: string): string {
  return version.replace(/^v/i, '')
}

export function addV(version: string): string {
  return version.startsWith('v') ? version : `v${version}`
}
