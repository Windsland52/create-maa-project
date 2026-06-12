#!/usr/bin/env node
import { parseArgs } from './args.js'
import { runDoctor } from './doctor.js'
import { applyIncrementalAddons } from './incremental-addons.js'
import { createLogger } from './log.js'
import {
  resolveOcrManifestFromEnvironment,
  resolveProductAssetManifest,
  type DownloadProgress,
  type DownloadProgressReporter
} from './assets.js'
import {
  acceptManagedChanges,
  cleanCache,
  diffManagedFiles,
  restoreBackup,
  withProjectWriteLock
} from './project.js'
import { promptForCreateOptions } from './prompt.js'
import { createProject } from './scaffold.js'
import { syncProject } from './sync.js'
import type { ScaffoldResult } from './types.js'
import { previewTemplateUpdate, recordUpdateRequests } from './update.js'

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const logger = await createLogger(process.cwd(), options.logFile)
  let clearActiveProgress = (): void => {}

  try {
    if (options.doctor || options.diff || options.acceptChangesRequested || options.logFile) {
      await logger.info(`argv=${JSON.stringify(process.argv.slice(2))}`)
    }
    if (options.assist || options.from) {
      throw new Error(
        'Agent-assisted creation is reserved for a future version and is not supported in v1.'
      )
    }
    if (options.migrate || options.target || options.dryRun) {
      throw new Error(
        'Legacy migration is reserved for a future version and is not supported in v1.'
      )
    }
    if (options.cleanCache) {
      const cleaned = await cleanCache(process.cwd())
      console.log(`Cleaned cache: ${cleaned}`)
      console.log(`Log: ${logger.path}`)
      return
    }

    if (options.restore) {
      const restored = await withProjectWriteLock(
        process.cwd(),
        process.argv.join(' '),
        () => restoreBackup(process.cwd(), options.restore as string),
        { clearStale: options.clearStaleLock }
      )
      console.log(`Restored files: ${restored.join(', ')}`)
      console.log(`Log: ${logger.path}`)
      return
    }

    if (options.acceptChangesRequested) {
      const accepted = await withProjectWriteLock(
        process.cwd(),
        process.argv.join(' '),
        () => acceptManagedChanges(process.cwd(), options.acceptChanges),
        { clearStale: options.clearStaleLock }
      )
      console.log(`Accepted managed changes: ${accepted.join(', ')}`)
      console.log(`Log: ${logger.path}`)
      return
    }

    if (options.doctor) {
      const report = await runDoctor(process.cwd())
      console.log(options.report ? JSON.stringify(report, null, 4) : report.lines.join('\n'))
      console.log(`Log: ${logger.path}`)
      process.exitCode = report.ok ? 0 : 1
      return
    }

    if (options.diff && options.update.length > 0) {
      const diff = await previewTemplateUpdate(options)
      console.log(diff.join('\n'))
      console.log(`Log: ${logger.path}`)
      return
    }

    if (options.diff) {
      const diff = await diffManagedFiles(process.cwd())
      console.log(diff.join('\n'))
      console.log(`Log: ${logger.path}`)
      return
    }

    if (options.sync) {
      const result = await syncProject(options)
      printScaffoldResult('Synchronized project', result)
      console.log(`Log: ${logger.path}`)
      return
    }

    if (options.update.length > 0) {
      const progress = createDownloadProgressHandlers(updateProgressLabel(options.update))
      clearActiveProgress = progress.clear
      const result = await recordUpdateRequests(options, {
        productManifestResolver: (request) => resolveProductAssetManifest(request),
        ocrManifestResolver: () => resolveOcrManifestFromEnvironment(),
        onProgress: progress.onProgress,
        onDownloadProgress: progress.onDownloadProgress
      })
      progress.clear()
      clearActiveProgress = (): void => {}
      printScaffoldResult('Recorded update request', result)
      console.log(`Log: ${logger.path}`)
      return
    }

    if (options.add.length > 0 && !options.name) {
      const lastResult = await applyIncrementalAddons(options)
      if (lastResult) printScaffoldResult('Updated project', lastResult)
      console.log(`Log: ${logger.path}`)
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
      onDownloadProgress: progress.onDownloadProgress
    })
    progress.clear()
    clearActiveProgress = (): void => {}
    const projectLogger = await createLogger(result.root, options.logFile)
    await projectLogger.info(`created=${result.root}`)
    printScaffoldResult('Created project', result)
    console.log(`Log: ${projectLogger.path}`)
  } catch (error) {
    clearActiveProgress()
    await logger.error(error)
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`)
    } else {
      console.error(`Error: ${String(error)}`)
    }
    console.error(`Log: ${logger.path}`)
    process.exitCode = 1
  }
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
    clear: () => bar.clear()
  }
}

function updateProgressLabel(targets: string[]): string {
  if (targets.some((target) => target === 'maafw' || target === 'runtime:mfa'))
    return 'Runtime assets'
  if (targets.includes('ocr-models')) return 'OCR models'
  return 'Downloads'
}

function createDownloadProgressBar(
  label: string,
  stream: NodeJS.WriteStream = process.stdout
): {
  update: (progress: DownloadProgress) => void
  clear: () => void
} {
  let renderedLine = ''
  return {
    update: (progress) => {
      if (!stream.isTTY) return
      const line = formatDownloadProgress(label, progress, stream.columns ?? 80)
      const padding =
        renderedLine.length > line.length ? ' '.repeat(renderedLine.length - line.length) : ''
      stream.write(`\r${line}${padding}`)
      renderedLine = line
    },
    clear: () => {
      if (!stream.isTTY || renderedLine.length === 0) return
      stream.write(`\r${' '.repeat(renderedLine.length)}\r`)
      renderedLine = ''
    }
  }
}

function formatDownloadProgress(
  label: string,
  progress: DownloadProgress,
  columns: number
): string {
  const totalBytes = progress.totalBytes
  const ratio =
    totalBytes !== undefined && totalBytes > 0
      ? Math.min(1, progress.downloadedBytes / totalBytes)
      : undefined
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
    'GB'
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
      console.log(
        `Git: initialized; initial commit skipped (${result.git.reason ?? 'not committed'})`
      )
    } else {
      console.log('Git: initialized and committed.')
    }
  }
}

void main()
