import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { DEMO_GIT_ENV } from './fixture'

/** Where every still and video lands: the Astro site's public folder. */
export const SHOTS = path.join(__dirname, '../public/shots')

/** 16:10 and small enough for a laptop screen; macOS clamps windows to the display. */
export const WINDOW = { width: 1408, height: 880 }

export type Box = { x: number; y: number; width: number; height: number }

/** Launches the built app on a demo profile; the caller closes it. */
export function launchDemo(profile: string): Promise<ElectronApplication> {
  return _electron.launch({
    args: [
      path.join(__dirname, '../../out/main/index.js'),
      `--user-data-dir=${profile}`,
      '--force-device-scale-factor=2',
      '--disable-background-networking'
    ],
    env: { ...process.env, ...DEMO_GIT_ENV, LOOM_DATA_DIR: profile }
  })
}

/** The main window at capture size, offline, with fonts loaded. */
export async function demoWindow(app: ElectronApplication): Promise<Page> {
  await app.context().route(/^https?:/, (route) => route.abort())
  const win = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height)
  }, WINDOW)
  await win.evaluate(() => document.fonts.ready)
  return win
}

/** The search workspace's main session beside its Changes tab. */
export async function openSearchSession(win: Page): Promise<void> {
  await win.locator('.home-card', { hasText: 'add-project-search' }).click()
  await win.locator('.session-tab', { hasText: 'Add project search' }).click()
  await win.getByRole('tab', { name: /Changes/ }).click()
  await expect(win.getByText('Loading changes…')).toHaveCount(0, { timeout: 15000 })
  // The terminal runs a real shell whose prompt shows the developer's user and host names.
  await win.getByRole('button', { name: 'Collapse terminal' }).click()
  await expect(win.getByRole('button', { name: 'Expand terminal' })).toBeVisible()
  await blur(win)
}

/** Chapter 02's frame, still and video alike: the sidebar and the start of the conversation. */
export async function workspaceFrame(win: Page): Promise<Box> {
  const width = (await box(win.locator('aside'))).width + 330
  return { x: 0, y: 0, width, height: width / (9 / 7) }
}

export async function box(target: Locator): Promise<Box> {
  const found = await target.first().boundingBox()
  if (found === null) throw new Error(`${target} not on screen`)
  return found
}

/** Clicks leave a focus ring; marketing frames should not. */
export async function blur(win: Page): Promise<void> {
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

/** Fails the run if anything personal reaches the screen. */
export async function assertNothingPersonal(win: Page): Promise<void> {
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
