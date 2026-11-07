import { test, expect, _electron } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('app boots, renders the shell and answers ping over the bridge', async () => {
  // A temp profile keeps this boot smoke runnable while a packaged instance holds the
  // real one: the single-instance lock is keyed on the user-data directory.
  const profile = mkdtempSync(path.join(tmpdir(), 'loom-boot-'))
  const app = await _electron.launch({
    args: [path.join(__dirname, '../../out/main/index.js'), `--user-data-dir=${profile}`],
    env: { ...process.env, LOOM_DATA_DIR: profile }
  })
  try {
    const win = await app.firstWindow()
    await expect(win).toHaveTitle('Loom')
    const pong = await win.evaluate(() => (globalThis as unknown as { loom: { ping(): string } }).loom.ping())
    expect(pong).toBe('pong')
    // Branding was removed by design; the stable chrome is the top nav and the foot.
    const nav = win.locator('.side-nav')
    await expect(nav).toContainText('New')
    await expect(nav).toContainText('Home')
    await expect(nav).toContainText('Search')
    await expect(win.locator('.side-foot')).toContainText('Settings')

    // ⌘N is the sidebar's New: the prompt-first modal, and Escape closes it again.
    await win.keyboard.press('Meta+n')
    await expect(win.locator('.nw-modal')).toBeVisible()
    await win.keyboard.press('Escape')
    await expect(win.locator('.nw-modal')).toBeHidden()
  } finally {
    await app.close()
    rmSync(profile, { recursive: true, force: true })
  }
})
