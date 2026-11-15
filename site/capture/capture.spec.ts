import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron, expect, test, type Page } from '@playwright/test'
import { buildFixture } from './fixture'

/**
 * Not a test: drives the real renderer over a synthetic profile and writes the
 * website's screenshots. Run with `pnpm site:shots`.
 */
const OUT = path.join(__dirname, '../shots')
// 16:10 and small enough for a laptop screen; macOS clamps windows to the display.
const WINDOW = { width: 1408, height: 880 }

/** Fails the run if anything personal reaches the screen. */
async function assertNothingPersonal(win: Page): Promise<void> {
  const text = await win.evaluate(() => document.body.innerText)
  const personal = [os.homedir(), os.userInfo().username]
  for (const key of ['user.name', 'user.email']) {
    try {
      personal.push(execFileSync('git', ['config', '--global', key], { encoding: 'utf8' }).trim())
    } catch {
      // Unset in this environment: nothing to leak.
    }
  }
  const leaked = personal.filter((value) => value !== '' && text.includes(value))
  expect(leaked, 'personal details visible in a capture').toEqual([])
}

type Box = { x: number; y: number; width: number; height: number }

async function shot(win: Page, name: string, clip?: Box) {
  await assertNothingPersonal(win)
  await win.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled', caret: 'hide', clip })
}

/** A crop at a fixed width:height ratio, clamped to the window. */
function crop(x: number, y: number, width: number, ratio: number): Box {
  const w = Math.min(width, WINDOW.width - x)
  return { x, y, width: w, height: Math.min(w / ratio, WINDOW.height - y) }
}

async function box(win: Page, selector: string): Promise<Box> {
  const found = await win.locator(selector).first().boundingBox()
  if (found === null) throw new Error(`${selector} not on screen`)
  return found
}

test('capture website screenshots', async () => {
  mkdirSync(OUT, { recursive: true })
  const profile = buildFixture()
  const app = await _electron.launch({
    args: [
      path.join(__dirname, '../../out/main/index.js'),
      `--user-data-dir=${profile}`,
      '--force-device-scale-factor=2',
      '--disable-background-networking'
    ],
    env: { ...process.env, LOOM_DATA_DIR: profile }
  })
  try {
    await app.context().route(/^https?:/, (route) => route.abort())
    const win = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height)
    }, WINDOW)
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await win.evaluate(() => document.fonts.ready)

    await win.locator('.home-card', { hasText: 'add-project-search' }).click()
    await win.locator('.session-tab', { hasText: 'Add project search' }).click()
    await win.getByRole('tab', { name: /Changes/ }).click()
    await expect(win.getByText('Loading changes…')).toHaveCount(0, { timeout: 15000 })
    await win.getByRole('button', { name: 'Collapse terminal' }).click()
    await win.locator('.chat-group-head').first().click()
    // Clicks leave a focus ring; a marketing still should not.
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const side = (await box(win, 'aside')).width

    // S01 hero, S02 workspace list; phones get 4:5 crops of the same state.
    await shot(win, 's01')
    await shot(win, 's01-m', crop(0, 0, 704, 4 / 5))
    await shot(win, 's02', crop(0, 0, side + 330, 9 / 7))
    await shot(win, 's02-m', crop(0, 0, 320, 4 / 5))

    // S03: the diff beside the Changes list, sidebar hidden so code lines fit.
    await win.locator('.change-row', { hasText: 'src/search.ts' }).click()
    await expect(win.locator('.viewer-host')).toBeVisible()
    await win.getByRole('button', { name: 'Hide sidebar' }).click()
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await shot(win, 's03')
    await shot(win, 's03-m', crop(0, 0, 704, 4 / 5))
    await win.getByRole('button', { name: 'Show sidebar' }).click()

    // S04: closed sessions in Recent chats over the conversation.
    await win.locator('.session-tab', { hasText: 'Add project search' }).click()
    await win.locator('[aria-label="Recent chats"]').click()
    const recent = await box(win, '.recent-chats')
    await shot(win, 's04', crop(side, 0, recent.x + recent.width + 24 - side, 3 / 2))
    await shot(win, 's04-m', crop(recent.x - 24, 0, recent.width + 48, 4 / 5))
  } finally {
    await app.close()
  }
})
