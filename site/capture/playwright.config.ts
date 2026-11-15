import { defineConfig } from '@playwright/test'

/** Website screenshot and video capture; deliberately outside the test/e2e suite. */
export default defineConfig({
  testDir: '.',
  timeout: 180000,
  retries: 0,
  // Every capture rebuilds the same /tmp/loombox-demo, so they must run one at a time.
  workers: 1,
  reporter: 'list',
  use: { trace: 'off' }
})
