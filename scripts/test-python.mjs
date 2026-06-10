import { spawn } from 'node:child_process'

const candidates =
  process.platform === 'win32'
    ? [
        ['py', '-3'],
        ['python'],
        ['python3']
      ]
    : [['python3'], ['python']]

for (const [command, ...baseArgs] of candidates) {
  const code = await run(command, [
    ...baseArgs,
    '-m',
    'unittest',
    'discover',
    '-s',
    'tests',
    '-p',
    'test_*.py'
  ])
  if (code === undefined) continue
  process.exitCode = code
  process.exit()
}

console.error('No Python interpreter found for PyPI wrapper tests.')
process.exitCode = 1

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit'
    })
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => resolve(code ?? 1))
  })
}
