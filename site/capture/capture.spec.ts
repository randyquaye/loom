import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import {
  assertNothingPersonal,
  blur,
  box,
  demoWindow,
  launchDemo,
  openSearchSession,
  SHOTS,
  WINDOW,
  workspaceFrame,
  type Box
} from './app'
import { buildFixture } from './fixture'

/**
 * Not a test: drives the real renderer over a synthetic profile and writes the
 * website's screenshots. Run with `pnpm site:shots`.
 */

async function shot(win: Page, name: string, clip?: Box) {
  await assertNothingPersonal(win)
  await win.screenshot({
    path: path.join(SHOTS, `${name}.png`),
    animations: 'disabled',
    caret: 'hide',
    ...(clip && { clip })
  })
}

/** A crop at a fixed width:height ratio, clamped to the window. */
function crop(x: number, y: number, width: number, ratio: number): Box {
  const w = Math.min(width, WINDOW.width - x)
  return { x, y, width: w, height: Math.min(w / ratio, WINDOW.height - y) }
}

test('capture website screenshots', async () => {
  mkdirSync(SHOTS, { recursive: true })
  const app = await launchDemo(buildFixture())
  try {
    const win = await demoWindow(app)
    await win.emulateMedia({ reducedMotion: 'reduce' })
    await openSearchSession(win)
    await win.locator('.chat-group-head').first().click()
    await blur(win)
    const side = (await box(win.locator('aside'))).width

    // S01 hero, S02 workspace list; phones get 4:5 crops of the same state.
    await shot(win, 's01')
    await shot(win, 's01-m', crop(0, 0, 704, 4 / 5))
    await shot(win, 's02', await workspaceFrame(win))
    await shot(win, 's02-m', crop(0, 0, 320, 4 / 5))

    // S03: the diff beside the Changes list, sidebar hidden so code lines fit.
    await win.locator('.change-row', { hasText: 'src/search.ts' }).click()
    await expect(win.locator('.viewer-host')).toBeVisible()
    await win.getByRole('button', { name: 'Hide sidebar' }).click()
    await blur(win)
    await shot(win, 's03')
    await shot(win, 's03-m', crop(0, 0, 704, 4 / 5))
    await win.getByRole('button', { name: 'Show sidebar' }).click()

    // S04: closed sessions in Recent chats over the conversation.
    await win.locator('.session-tab', { hasText: 'Add project search' }).click()
    await win.locator('[aria-label="Recent chats"]').click()
    const recent = await box(win.locator('.recent-chats'))
    await shot(win, 's04', crop(side, 0, recent.x + recent.width + 24 - side, 3 / 2))
    await shot(win, 's04-m', crop(recent.x - 24, 0, recent.width + 48, 4 / 5))
  } finally {
    await app.close()
  }
})
