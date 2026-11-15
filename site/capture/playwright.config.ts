import { defineConfig } from '@playwright/test'

/** Website screenshot capture; deliberately outside the test/e2e suite. */
export default defineConfig({
  testDir: '.',
  timeout: 120000,
  retries: 0,
  reporter: 'list',
  use: { trace: 'off' }
})
