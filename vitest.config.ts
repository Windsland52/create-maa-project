import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    testTimeout: 15_000,
    include: [
      'tests/**/*.test.ts',
    ],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/templates.generated.ts', 'src/types.ts'],
      reporter: [
        'text',
      ],
      thresholds: {
        statements: 82,
        // Vitest 4 remaps V8 coverage through the AST (ast-v8-to-istanbul), which attributes more
        // real branches than the v3 engine did: this suite measures 74.4% here where it used to
        // report 81.7% for the same tests. The floor keeps the old slack on the new scale.
        branches: 73,
        functions: 85,
        lines: 82,
      },
    },
  },
})
