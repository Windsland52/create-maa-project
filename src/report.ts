import { randomUUID } from 'node:crypto'
import type { DoctorReport } from './doctor.js'
import type { BackupInspection, BackupSummary } from './project.js'
import type { CliOptions, GitInitResult, PendingItem, ScaffoldResult } from './types.js'

export type CliReportCommand = 'create' | 'sync' | 'update' | 'doctor' | 'backup'

export type SuggestedCommand = {
  command: string
  description: string
  autoRun: boolean
}

export type BackupJsonResult =
  | { operation: 'list'; backups: BackupSummary[] }
  | { operation: 'show' | 'restore-preview'; backup: BackupInspection }
  | { operation: 'restore'; backupId: string; restored: string[]; removed: string[]; preRestoreBackupId: string }

export type CliJsonReport = {
  schemaVersion: 1
  tool: 'create-maa-project'
  command: CliReportCommand
  ok: boolean
  timestamp: string
  durationMs: number
  exitCode: 0 | 1
  executionId: string
  root: string
  logPath: string | null
  written: string[]
  removed: string[]
  skipped: string[]
  pending: PendingItem[]
  suggestedCommands: SuggestedCommand[]
  backupId?: string
  backupScope?: 'managed-files'
  git?: GitInitResult
  doctor?: {
    lines: string[]
  }
  backup?: BackupJsonResult
  error?: {
    message: string
    code?: string
  }
}

export type ReportContext = {
  command: CliReportCommand
  startTimeMs: number
  executionId: string
  logPath: string | null
}

export function createReportExecutionId(date = new Date()): string {
  return `${date.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
}

export function reportRequested(argv: string[]): boolean {
  return argv.includes('--report')
}

export function inferReportCommandFromArgv(argv: string[]): CliReportCommand {
  if (argv.includes('--list-backups') || argv.includes('--show-backup') || argv.includes('--restore')) return 'backup'
  if (argv.includes('--doctor')) return 'doctor'
  if (argv.includes('--sync')) return 'sync'
  if (argv.includes('--update')) return 'update'
  return 'create'
}

export function reportCommandFromOptions(options: CliOptions): CliReportCommand {
  if (options.listBackups || options.showBackup || options.restore) return 'backup'
  if (options.doctor) return 'doctor'
  if (options.sync) return 'sync'
  if (options.update.length > 0) return 'update'
  return 'create'
}

export function assertReportSupportedOptions(options: CliOptions): void {
  if (options.cleanCache) {
    throw new Error('--report does not support --clean-cache in this version.')
  }
  if (options.add.length > 0 && !options.name && !options.sync && options.update.length === 0 && !options.doctor) {
    throw new Error('--report does not support incremental --add commands in this version.')
  }
}

export function createScaffoldJsonReport(context: ReportContext, result: ScaffoldResult): CliJsonReport {
  const report = createBaseReport({
    context,
    ok: true,
    exitCode: 0,
    root: result.root,
    written: result.written,
    skipped: result.skipped,
    pending: result.pending,
    suggestedCommands: suggestedCommandsFromPending(result.pending),
  })
  if (result.git) report.git = result.git
  if (result.backupId) {
    report.backupId = result.backupId
    report.backupScope = 'managed-files'
  }
  return report
}

export function createDoctorJsonReport(input: {
  context: ReportContext
  root: string
  doctor: DoctorReport
}): CliJsonReport {
  const suggestedCommands = uniqueSuggestedCommands(suggestedCommandsFromLines(input.doctor.lines))
  const report = createBaseReport({
    context: input.context,
    ok: input.doctor.ok,
    exitCode: input.doctor.ok ? 0 : 1,
    root: input.root,
    suggestedCommands,
  })
  report.doctor = {
    lines: input.doctor.lines,
  }
  return report
}

export function createBackupJsonReport(input: {
  context: ReportContext
  root: string
  backup: BackupJsonResult
}): CliJsonReport {
  const written = input.backup.operation === 'restore' ? input.backup.restored : []
  const removed = input.backup.operation === 'restore' ? input.backup.removed : []
  const report = createBaseReport({
    context: input.context,
    ok: true,
    exitCode: 0,
    root: input.root,
    written,
    removed,
  })
  report.backup = input.backup
  report.backupScope = 'managed-files'
  if (input.backup.operation === 'restore') {
    report.backupId = input.backup.preRestoreBackupId
  }
  return report
}

export function createErrorJsonReport(input: { context: ReportContext; root: string; error: unknown }): CliJsonReport {
  const report = createBaseReport({
    context: input.context,
    ok: false,
    exitCode: 1,
    root: input.root,
  })
  const code = errorCode(input.error)
  report.error = code
    ? {
        message: errorMessage(input.error),
        code,
      }
    : {
        message: errorMessage(input.error),
      }
  return report
}

export function writeJsonReport(report: CliJsonReport): void {
  process.stdout.write(`${JSON.stringify(report, null, 4)}\n`)
}

function createBaseReport(input: {
  context: ReportContext
  ok: boolean
  exitCode: 0 | 1
  root: string
  written?: string[]
  removed?: string[]
  skipped?: string[]
  pending?: PendingItem[]
  suggestedCommands?: SuggestedCommand[]
}): CliJsonReport {
  return {
    schemaVersion: 1,
    tool: 'create-maa-project',
    command: input.context.command,
    ok: input.ok,
    timestamp: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - input.context.startTimeMs),
    exitCode: input.exitCode,
    executionId: input.context.executionId,
    root: input.root,
    logPath: input.context.logPath,
    written: input.written ?? [],
    removed: input.removed ?? [],
    skipped: input.skipped ?? [],
    pending: input.pending ?? [],
    suggestedCommands: uniqueSuggestedCommands(input.suggestedCommands ?? []),
  }
}

function suggestedCommandsFromPending(pending: PendingItem[]): SuggestedCommand[] {
  return pending.map((item) => ({
    command: item.command,
    description: item.reason,
    autoRun: false,
  }))
}

function suggestedCommandsFromLines(lines: string[]): SuggestedCommand[] {
  const suggestions: SuggestedCommand[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const command = line?.match(/^\s*To (?:fix|accept):\s*(.+?)\s*$/)?.[1]?.trim()
    if (!command || !isExecutableCommand(command)) continue
    suggestions.push({
      command,
      description: descriptionBefore(lines, index),
      autoRun: false,
    })
  }
  return uniqueSuggestedCommands(suggestions)
}

function uniqueSuggestedCommands(commands: SuggestedCommand[]): SuggestedCommand[] {
  const seen = new Set<string>()
  const unique: SuggestedCommand[] = []
  for (const item of commands) {
    if (seen.has(item.command)) continue
    seen.add(item.command)
    unique.push(item)
  }
  return unique
}

function descriptionBefore(lines: string[], index: number): string {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor]?.trim()
    if (!line || /^To (?:fix|accept):/.test(line)) continue
    return line.replace(/^\[(?:OK|ERR|WARN|INFO)\]\s*/, '')
  }
  return 'Suggested follow-up command'
}

function isExecutableCommand(command: string): boolean {
  return /^(create-maa-project|pnpm|uv|npm|npx)(?:\s|$)/.test(command)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const value = (error as { code?: unknown }).code
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return undefined
}
