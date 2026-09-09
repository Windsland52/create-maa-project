import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'

export function spawnCommand(
  root: string,
  command: string,
  args: string[],
  stdio: StdioOptions = 'inherit',
): ChildProcess {
  // Windows command shims need cmd.exe. Expand arguments through environment
  // variables so absolute paths containing spaces stay single arguments.
  const env: NodeJS.ProcessEnv = { ...process.env, CREATE_MAA_PROJECT_RUN_COMMAND: command }
  const placeholders = args.map((value, index) => {
    if (value === '') return '""'
    const name = `CREATE_MAA_PROJECT_RUN_ARG_${index}`
    env[name] = value
    return `"%${name}%"`
  })
  // Quoting a bare shim name makes cmd.exe resolve its %~dp0 against cwd.
  const windowsCommand = /^[\w.-]+$/.test(command)
    ? '%CREATE_MAA_PROJECT_RUN_COMMAND%'
    : '"%CREATE_MAA_PROJECT_RUN_COMMAND%"'
  const windows = process.platform === 'win32'
  return spawn(
    windows ? (process.env.ComSpec ?? 'cmd.exe') : command,
    windows ? ['/d', '/s', '/v:off', '/c', `"${windowsCommand} ${placeholders.join(' ')}"`] : args,
    {
      cwd: root,
      stdio,
      windowsHide: true,
      ...(windows ? { env, windowsVerbatimArguments: true } : {}),
    },
  )
}

export async function runCommand(root: string, command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnCommand(root, command, args)
    child.on('error', (error) => {
      reject(new Error(`Failed to run ${[command, ...args].join(' ')}. ${error.message}`))
    })
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      reject(new Error(`Command failed: ${[command, ...args].join(' ')} (${suffix})`))
    })
  })
}
