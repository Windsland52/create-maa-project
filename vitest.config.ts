import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    include: [
      'tests/**/*.test.ts'
    ],
    coverage: {
      reporter: [
        'text'
      ]
    }
  }
})
