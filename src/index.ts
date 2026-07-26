#!/usr/bin/env node
import { spawn } from 'node:child_process'
import packageJson from '../package.json' with { type: 'json' }
import { formatCliHelp, parseArgs, validateCommandModes } from './args.js'
import { runDoctor } from './doctor.js'
import { applyIncrementalAddons } from './incremental-addons.js'
import { createLogger, type Logger } from './log.js'
import {
  resolveOcrManifestFromEnvironment,
  resolveProductAssetManifest,
  type DownloadProgress,
  type DownloadProgressReporter,
} from './assets.js'
import {
  cleanCache,
  inspectProjectBackup,
  listProjectBackups,
  restoreBackup,
  withProjectLock,
  type BackupInspection,
} from './project.js'
import { promptForCreateOptions } from './prompt.js'
import {
  assertReportSupportedOptions,
  createBackupJsonReport,
  createCleanCacheJsonReport,
  createDoctorJsonReport,
  createErrorJsonReport,
  createReportExecutionId,
  createScaffoldJsonReport,
  inferReportCommandFromArgv,
  reportCommandFromOptions,
  reportRequested,
  type BackupJsonResult,
  type CliReportCommand,
  type ReportContext,
  writeJsonReport,
} from './report.js'
import { createProject } from './scaffold.js'
import { syncProject } from './sync.js'
import type { CliOptions, ScaffoldResult } from './types.js'
import { recordUpdateRequests } from './update.js'

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const startTimeMs = Date.now()
  const executionId = createReportExecutionId(new Date(startTimeMs))
  const wantsReport = reportRequested(argv)
  let command: CliReportCommand = inferReportCommandFromArgv(argv)
  let logger: Logger | undefined
  let logFile: string | undefined
  let clearActiveProgress = (): void => {}

  try {
    const options = parseArgs(argv)
    validateCommandModes(options)
    if (options.help) {
      console.log(formatCliHelp(packageJson.version))
      return
    }
    if (options.cliVersion) {
      console.log(packageJson.version)
      return
    }
    if (options.mcp) {
      const { startMcpServer } = await import('./mcp.js')
      await startMcpServer()
      return
    }
    if (options.report) options.noInteractive = true
    command = reportCommandFromOptions(options)
    logFile = options.logFile
    logger = await createLogger(process.cwd(), options.logFile, options.report ? executionId : undefined)
    if (options.report) {
      assertReportSupportedOptions(options)
    }
    if (options.doctor || options.logFile) {
      await logger.info(`argv=${JSON.stringify(process.argv.slice(2))}`)
    }
    if (options.assist || options.from) {
      throw new Error('Agent-assisted creation is reserved for a future version and is not supported in v1.')
    }
    if (options.migrate || options.target) {
      throw new Error('Legacy migration is reserved for a future version and is not supported in v1.')
    }

    if (options.report) {
      if (options.cleanCache) {
        const root = process.cwd()
        const cachePath = await cleanCache(root)
        const report = createCleanCacheJsonReport({
          context: createReportContext(command, startTimeMs, executionId, logger),
          root,
          cachePath,
        })
        writeJsonReport(report)
        process.exitCode = report.exitCode
        return
      }

      if (isBackupCommand(options)) {
        const root = process.cwd()
        const backup = await executeBackupCommand(root, options)
        const report = createBackupJsonReport({
          context: createReportContext(command, startTimeMs, executionId, logger),
          root,
          backup,
        })
        writeJsonReport(report)
        process.exitCode = report.exitCode
        return
      }

      if (options.doctor) {
        const root = process.cwd()
        const doctor = await runDoctor(root)
        const report = createDoctorJsonReport({
          context: createReportContext(command, startTimeMs, executionId, logger),
          root,
          doctor,
        })
        writeJsonReport(report)
        process.exitCode = report.exitCode
        return
      }

      if (options.sync) {
        const result = await syncProject(options)
        const report = createScaffoldJsonReport(createReportContext(command, startTimeMs, executionId, logger), result)
        writeJsonReport(report)
        process.exitCode = report.exitCode
        return
      }

      if (options.update.length > 0) {
        const progress = createReportProgressHandlers(updateProgressLabel(options.update))
        clearActiveProgress = progress.clear
        const result = await recordUpdateRequests(options, {
          commandRunner: runReportChildCommand,
          productManifestResolver: (request) => resolveProductAssetManifest(request),
          ocrManifestResolver: () => resolveOcrManifestFromEnvironment(),
          onProgress: progress.onProgress,
          onDownloadProgress: progress.onDownloadProgress,
        })
        progress.clear()
        clearActiveProgress = (): void => {}
        const report = createScaffoldJsonReport(createReportContext(command, startTimeMs, executionId, logger), result)
        writeJsonReport(report)
        process.exitCode = report.exitCode
        return
      }

      const createOptions = await promptForCreateOptions(options)
      const progress = createReportProgressHandlers('OCR models')
      clearActiveProgress = progress.clear
      const result = await createProject(createOptions, {
        installNodeDeps: true,
        downloadOcrModels: true,
        commandRunner: runReportChildCommand,
        ocrManifestResolver: () => resolveOcrManifestFromEnvironment(),
        onProgress: progress.onProgress,
        onDownloadProgress: progress.onDownloadProgress,
      })
      progress.clear()
      clearActiveProgress = (): void => {}
      const projectLogger = await createLogger(result.root, options.logFile, executionId)
      logger = projectLogger
      await projectLogger.info(`created=${result.root}`)
      const report = createScaffoldJsonReport(createReportContext(command, startTimeMs, executionId, logger), result)
      writeJsonReport(report)
      process.exitCode = report.exitCode
      return
    }

    if (options.cleanCache) {
      const cleaned = await cleanCache(process.cwd())
      console.log(`Cleaned cache: ${cleaned}`)
      printLogPath(logger)
      return
    }

    if (isBackupCommand(options)) {
      const backup = await executeBackupCommand(process.cwd(), options)
      printBackupResult(backup)
      if (backup.operation === 'restore') printLogPath(logger)
      return
    }

    if (options.doctor) {
      const report = await runDoctor(process.cwd())
      console.log(options.report ? JSON.stringify(report, null, 4) : report.lines.join('\n'))
      printLogPath(logger)
      process.exitCode = report.ok ? 0 : 1
      return
    }

    if (options.sync) {
      const result = await syncProject(options)
      printScaffoldResult('Synchronized project', result)
      printLogPath(logger)
      return
    }

    if (options.update.length > 0) {
      const progress = createDownloadProgressHandlers(updateProgressLabel(options.update))
      clearActiveProgress = progress.clear
      const result = await recordUpdateRequests(options, {
        productManifestResolver: (request) => resolveProductAssetManifest(request),
        ocrManifestResolver: () => resolveOcrManifestFromEnvironment(),
        onProgress: progress.onProgress,
        onDownloadProgress: progress.onDownloadProgress,
      })
      progress.clear()
      clearActiveProgress = (): void => {}
      printScaffoldResult('Recorded update request', result)
      printLogPath(logger)
      return
    }

    if (options.add.length > 0 && !options.name) {
      const lastResult = await applyIncrementalAddons(options)
      if (lastResult) printScaffoldResult('Updated project', lastResult)
      printLogPath(logger)
      return
    }

    const createOptions = await promptForCreateOptions(options)
    const progress = createDownloadProgressHandlers('OCR models')
    clearActiveProgress = progress.clear
    const result = await createProject(createOptions, {
      installNodeDeps: true,
      downloadOcrModels: true,
      ocrManifestResolver: () => resolveOcrManifestFromEnvironment(),
      onProgress: progress.onProgress,
      onDownloadProgress: progress.onDownloadProgress,
    })
    progress.clear()
    clearActiveProgress = (): void => {}
    const projectLogger = await createLogger(result.root, options.logFile)
    await projectLogger.info(`created=${result.root}`)
    printScaffoldResult('Created project', result)
    printLogPath(projectLogger)
  } catch (error) {
    clearActiveProgress()
    logger = logger ?? (await tryCreateLogger(process.cwd(), logFile, wantsReport ? executionId : undefined))
    await safeLogError(logger, error)
    if (wantsReport) {
      const report = createErrorJsonReport({
        context: createReportContext(command, startTimeMs, executionId, logger),
        root: process.cwd(),
        error,
      })
      writeJsonReport(report)
      process.exitCode = report.exitCode
      return
    }
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    printLogPath(logger, true)
    process.exitCode = 1
  }
}

function isBackupCommand(options: CliOptions): boolean {
  return options.listBackups || options.showBackup !== undefined || options.restore !== undefined
}

async function executeBackupCommand(root: string, options: CliOptions): Promise<BackupJsonResult> {
  if (options.listBackups) {
    return withProjectLock(
      root,
      process.argv.join(' '),
      async () => ({ operation: 'list', backups: await listProjectBackups(root) }),
      { clearStale: options.clearStaleLock },
    )
  }
  if (options.showBackup) {
    return withProjectLock(
      root,
      process.argv.join(' '),
      async () => ({ operation: 'show', backup: await inspectProjectBackup(root, options.showBackup as string) }),
      { clearStale: options.clearStaleLock },
    )
  }
  if (!options.restore) throw new Error('Missing backup command.')
  const backupId = options.restore
  if (options.dryRun) {
    return withProjectLock(
      root,
      process.argv.join(' '),
      async () => ({ operation: 'restore-preview', backup: await inspectProjectBackup(root, backupId) }),
      { clearStale: options.clearStaleLock },
    )
  }
  return withProjectLock(
    root,
    process.argv.join(' '),
    async () => {
      await inspectProjectBackup(root, backupId)
      const restoreResult = await restoreBackup(root, backupId)
      return {
        operation: 'restore',
        backupId,
        restored: restoreResult.restored,
        removed: restoreResult.removed,
        preRestoreBackupId: restoreResult.backupId,
      }
    },
    { clearStale: options.clearStaleLock },
  )
}

function printBackupResult(result: BackupJsonResult): void {
  if (result.operation === 'list') {
    if (result.backups.length === 0) {
      console.log('No managed-files backups found.')
      return
    }
    console.log('Managed-files backups (newest first; .git is excluded):')
    for (const backup of result.backups) {
      const createdAt = backup.createdAt || 'unknown time'
      const command = backup.command ? `; ${backup.command}` : ''
      const error = backup.error ? `; invalid: ${backup.error}` : ''
      console.log(`- ${backup.id}: ${createdAt}; ${backup.status}; ${backup.entryCount} path(s)${command}${error}`)
    }
    return
  }
  if (result.operation === 'restore') {
    console.log(`Restored managed paths: ${result.restored.join(', ') || '(none)'}`)
    console.log(`Removed managed paths: ${result.removed.join(', ') || '(none)'}`)
    console.log(`Pre-restore managed-files backup: ${result.preRestoreBackupId}`)
    return
  }
  printBackupInspection(
    result.operation === 'show'
      ? `Managed-files backup ${result.backup.id} (.git is excluded)`
      : `Restore preview for ${result.backup.id} (no files changed; .git is excluded)`,
    result.backup,
  )
}

function printBackupInspection(title: string, backup: BackupInspection): void {
  console.log(title)
  console.log(`Created: ${backup.createdAt}`)
  console.log(`Format: ${backup.format}`)
  console.log(`Status: ${backup.status}`)
  if (backup.command) console.log(`Command: ${backup.command}`)
  if (backup.entries.length === 0) {
    console.log('Paths: (none)')
    return
  }
  console.log('Paths:')
  for (const entry of backup.entries) console.log(`- ${entry.action}: ${entry.path}`)
}

function createReportContext(
  command: CliReportCommand,
  startTimeMs: number,
  executionId: string,
  logger: Logger | undefined,
): ReportContext {
  return {
    command,
    startTimeMs,
    executionId,
    logPath: logger?.hasEntries() ? logger.path : null,
  }
}

function printLogPath(logger: Logger | undefined, error = false): void {
  if (!logger?.hasEntries()) return
  const line = `Log: ${logger.path}`
  if (error) console.error(line)
  else console.log(line)
}

async function tryCreateLogger(
  root: string,
  logFile: string | undefined,
  executionId: string | undefined,
): Promise<Logger | undefined> {
  try {
    return await createLogger(root, logFile, executionId)
  } catch {
    return undefined
  }
}

async function safeLogError(logger: Logger | undefined, error: unknown): Promise<void> {
  try {
    await logger?.error(error)
  } catch {
    // Error reporting must not fail before the CLI can print its user-facing result.
  }
}

function createReportProgressHandlers(label: string): {
  onProgress: (message: string) => void
  onDownloadProgress: DownloadProgressReporter
  clear: () => void
} {
  const bar = createDownloadProgressBar(label, process.stderr)
  return {
    onProgress: (message) => {
      bar.clear()
      process.stderr.write(`${message}\n`)
    },
    onDownloadProgress: (progress) => bar.update(progress),
    clear: () => bar.clear(),
  }
}

async function runReportChildCommand(root: string, command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: process.platform === 'win32',
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      reject(new Error(`Failed to run ${formatCommand(command, args)}. ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      reject(new Error(`Command failed: ${formatCommand(command, args)} (${suffix})`))
    })
  })
}

function formatCommand(command: string, args: string[]): string {
  return [
    command,
    ...args,
  ].join(' ')
}

function createDownloadProgressHandlers(label: string): {
  onProgress: (message: string) => void
  onDownloadProgress: DownloadProgressReporter
  clear: () => void
} {
  const bar = createDownloadProgressBar(label)
  return {
    onProgress: (message) => {
      bar.clear()
      console.log(message)
    },
    onDownloadProgress: (progress) => bar.update(progress),
    clear: () => bar.clear(),
  }
}

function updateProgressLabel(targets: string[]): string {
  if (targets.some((target) => target === 'maafw' || target === 'runtime:mfa')) return 'Runtime assets'
  if (targets.includes('ocr-models')) return 'OCR models'
  return 'Downloads'
}

function createDownloadProgressBar(
  label: string,
  stream: NodeJS.WriteStream = process.stdout,
): {
  update: (progress: DownloadProgress) => void
  clear: () => void
} {
  let renderedLine = ''
  return {
    update: (progress) => {
      if (!stream.isTTY) return
      const line = formatDownloadProgress(label, progress, stream.columns ?? 80)
      const padding = renderedLine.length > line.length ? ' '.repeat(renderedLine.length - line.length) : ''
      stream.write(`\r${line}${padding}`)
      renderedLine = line
    },
    clear: () => {
      if (!stream.isTTY || renderedLine.length === 0) return
      stream.write(`\r${' '.repeat(renderedLine.length)}\r`)
      renderedLine = ''
    },
  }
}

function formatDownloadProgress(label: string, progress: DownloadProgress, columns: number): string {
  const totalBytes = progress.totalBytes
  const ratio =
    totalBytes !== undefined && totalBytes > 0 ? Math.min(1, progress.downloadedBytes / totalBytes) : undefined
  const suffix =
    totalBytes === undefined || ratio === undefined
      ? formatBytes(progress.downloadedBytes)
      : `${Math.floor(ratio * 100)
          .toString()
          .padStart(3, ' ')}% ${formatBytes(progress.downloadedBytes)}/${formatBytes(totalBytes)}`
  const width = Math.max(20, columns)
  const availableBarWidth = width - label.length - suffix.length - 4
  if (availableBarWidth < 10 || ratio === undefined) {
    return `${label} ${suffix}`
  }
  const barWidth = Math.min(32, availableBarWidth)
  const filled = Math.min(barWidth, Math.round(barWidth * ratio))
  const bar = `${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}`
  return `${label} [${bar}] ${suffix}`
}

function formatBytes(bytes: number): string {
  const units = [
    'B',
    'KB',
    'MB',
    'GB',
  ]
  let value = bytes
  let unit = units[0] as string
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index] as string
  }
  return unit === 'B' ? `${bytes} B` : `${value.toFixed(1)} ${unit}`
}

function printScaffoldResult(title: string, result: ScaffoldResult): void {
  console.log(`${title}: ${result.root}`)
  console.log(`Written files: ${result.written.length}`)
  if (result.backupId) console.log(`Managed-files backup: ${result.backupId}`)
  if (result.skipped.length > 0) {
    console.log(`Skipped existing files: ${result.skipped.join(', ')}`)
  }
  if (result.pending.length > 0) {
    console.log('Pending actions:')
    for (const item of result.pending) {
      console.log(`- ${item.kind}: ${item.command}`)
    }
    console.log(`Run pending commands from project root: ${result.root}`)
  }
  if (result.git) {
    if (!result.git.initialized) {
      console.log(`Git: skipped (${result.git.reason ?? 'not initialized'})`)
    } else if (!result.git.committed) {
      console.log(`Git: initialized; initial commit skipped (${result.git.reason ?? 'not committed'})`)
    } else {
      console.log('Git: initialized and committed.')
    }
  }
}

void main()
