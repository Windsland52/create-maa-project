import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LOCAL_STATE_DIR } from './project.js'
import { nowIso } from './utils.js'

export type Logger = {
  path: string
  info(message: string): Promise<void>
  error(error: unknown): Promise<void>
}

export async function createLogger(root: string, logFile?: string): Promise<Logger> {
  if (logFile) {
    return createLoggerAt(logFile)
  }
  const dir = join(root, LOCAL_STATE_DIR, 'logs')
  const path = join(dir, `${nowIso().replace(/[:.]/g, '-')}.log`)
  return createLoggerAt(path)
}

function createLoggerAt(path: string): Logger {
  async function write(level: string, message: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `[${nowIso()}] [${level}] ${message}\n`, 'utf8')
  }
  return {
    path,
    info: (message) => write('INFO', message),
    error: async (error) => {
      const message =
        error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
      await write('ERROR', message)
    }
  }
}
