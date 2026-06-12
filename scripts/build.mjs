import { build } from 'esbuild'
import { chmod } from 'node:fs/promises'

await build({
  entryPoints: [
    'src/index.ts'
  ],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm'
})

await chmod('dist/index.js', 0o755)
