import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
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
        branches: 78,
        functions: 85,
        lines: 82,
      },
    },
  },
})
