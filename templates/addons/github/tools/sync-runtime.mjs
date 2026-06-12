import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const updateArgs = [
  '--update',
  'maafw',
  '--update',
  'runtime:mfa'
]
if (existsSync('pyproject.toml')) {
  if (runtimePlatformAll()) {
    console.warn(
      '[WARN] Skipping --update python-runtime because Agent release dependencies are platform-specific. Set CREATE_MAA_PROJECT_RUNTIME_PLATFORM=<os>-<arch> to sync them.'
    )
  } else {
    updateArgs.push('--update', 'python-runtime')
  }
}
const invocation = resolveCreateMaaProject()

const result = spawnSync(
  invocation.command,
  [
    ...invocation.args,
    ...updateArgs
  ],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: invocation.shell
  }
)

if (result.error) {
  throw result.error
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

function resolveCreateMaaProject() {
  const override = process.env.CREATE_MAA_PROJECT_BIN?.trim()
  if (override) {
    return {
      command: override,
      args: [],
      shell: true
    }
  }

  const localBin = findLocalGeneratorBin()
  if (localBin) {
    return {
      command: process.execPath,
      args: [
        localBin
      ],
      shell: false
    }
  }

  return {
    command: 'pnpm',
    args: [
      'dlx',
      'create-maa-project@latest'
    ],
    shell: process.platform === 'win32'
  }
}

function findLocalGeneratorBin() {
  let dir = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const bin = join(dir, 'dist', 'index.js')
    if (existsSync(bin) && packageName(dir) === 'create-maa-project') {
      return bin
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function runtimePlatformAll() {
  const value =
    process.env.CREATE_MAA_PROJECT_RUNTIME_PLATFORM?.trim() ||
    process.env.CREATE_MAA_PROJECT_PLATFORM?.trim() ||
    ''
  return value.toLowerCase() === 'all'
}

function packageName(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name
  } catch {
    return undefined
  }
}
