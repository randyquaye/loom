import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/renderer/**/*.test.ts'],
    environment: 'node'
  }
})
