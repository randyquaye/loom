import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import type { AgentEvent } from '../../src/shared/events'
import type { LoomApi } from '../../src/shared/ipc-contract'

const OUT = path.join(__dirname, '../../.qwen/tmp/loom-shots')
const PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'loom')

/**
 * Captures the key surfaces as PNGs so the UI can be audited visually without
 * OS screen-recording permission (CDP captures the webContents directly).
 * Uses a temporary copy of the seeded database via LOOM_DATA_DIR, with remote
 * browser requests blocked. Requires no other Loom instance
 * running (single-instance lock).
 */
test('capture ui surfaces for visual audit', async () => {
  mkdirSync(OUT, { recursive: true })
  const profile = mkdtempSync(path.join(os.tmpdir(), 'loom-shots-'))
  copyFileSync(path.join(PROFILE, 'loom.db'), path.join(profile, 'loom.db'))
  const app: ElectronApplication = await _electron.launch({
    args: [
      path.join(__dirname, '../../out/main/index.js'),
      `--user-data-dir=${profile}`,
      '--disable-background-networking'
    ],
    env: { ...process.env, LOOM_DATA_DIR: profile }
  })
  try {
    await app.context().route(/^https?:/, (route) => route.abort())
    const win = await app.firstWindow()
    await win.waitForTimeout(900)
    await win.screenshot({ animations: 'disabled', path: path.join(OUT, '01-home.png') })

    // First workspace row, whatever it is named: the seeded profile's workspace
    // name changes as real sessions are run through the app.
    const wsRow = win.locator('.ws-row').first()
    if ((await wsRow.count()) > 0) {
      await wsRow.click()
      await win.waitForTimeout(800)
    }
    // The live profile's tabs may all be closed; reopen the transcript that carries
    // the markdown table so the transcript assertions have content, via the new
    // recent-chats popover (which this also captures).
    if ((await win.locator('.session-tab').count()) === 0) {
      await win.locator('[aria-label="Recent chats"]').click()
      await win.waitForTimeout(400)
      await win.screenshot({ animations: 'disabled', path: path.join(OUT, '11-recent-chats.png') })
      await win.locator('.recent-chats-row', { hasText: 'gpt-6.1-sol' }).last().click()
      await win.waitForTimeout(600)
    }
    await win.screenshot({ animations: 'disabled', path: path.join(OUT, '02-workspace-chat.png') })
    await expect(win.locator('.chat-md table').first()).toBeAttached()
    await expect(win.locator('.chat-md strong').first()).toBeAttached()
    await expect(win.locator('.chat-md code').first()).toBeAttached()

    const head = win.locator('.chat-group-head').first()
    await head.scrollIntoViewIfNeeded()
    await win.screenshot({ animations: 'disabled', path: path.join(OUT, '02a-turn-collapsed.png') })
    await head.click()
    await expect(head).toHaveAttribute('aria-expanded', 'true')
    await expect(win.locator('.chat-tool')).toHaveCount(21)
    const rowGeometry = await win.locator('.chat-tool > .chat-row').evaluateAll((rows) =>
      rows.map((row) => ({
        height: row.getBoundingClientRect().height,
        width: row.getBoundingClientRect().width,
        available: row.closest('.chat-column')!.getBoundingClientRect().width
      }))
    )
    const badRows = rowGeometry.filter(
      (row) => !(row.height >= 32 && row.height < 40 && row.width <= row.available)
    )
    expect(badRows, `off-geometry tool rows: ${JSON.stringify(badRows)}`).toEqual([])
    expect(await head.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).boxShadow)).toBe(
      'none'
    )
    await win.screenshot({ animations: 'disabled', path: path.join(OUT, '02b-tools-expanded.png') })
    await win.locator('.chat-tool > button.chat-row').first().click()
    await expect(win.locator('.chat-output').first()).toBeVisible()
    await win.screenshot({ animations: 'disabled', path: path.join(OUT, '02c-tool-output.png') })
    await head.click()

    const pin = win.locator('.tab-pin').first()
    if ((await pin.count()) > 0) {
      await pin.click()
      await win.waitForTimeout(500)
      await win.screenshot({ animations: 'disabled', path: path.join(OUT, '03-viewer-tab.png') })
    }

    const treeRow = win.locator('.tree-row', { hasText: 'README.md' }).first()
    if ((await treeRow.count()) > 0) {
      await treeRow.click()
      await win.waitForTimeout(700)
      await win.screenshot({ animations: 'disabled', path: path.join(OUT, '03b-viewer-file.png') })
    }

    // Lazy tree: root-level files are visible without expanding anything, and
    // expanding a directory loads its children on demand.
    const visiblePanel = win.locator('.explorer-content:not([hidden])')
    await expect(visiblePanel.locator('.tree > .tree-row:not(.tree-dir)').first()).toBeAttached()
    const rowCount = await visiblePanel.locator('.tree-row').count()
    await visiblePanel.locator('.tree-dir').first().click()
    await win.waitForTimeout(500)
    expect(await visiblePanel.locator('.tree-row').count()).toBeGreaterThan(rowCount)

    // Changes tab: git status on a monorepo can outlive a fixed wait, so capture
    // only once the loading state resolves (rows or the clean empty state).
    await win.getByRole('tab', { name: /Changes/ }).click()
    await expect(win.getByText('Loading changes…')).toHaveCount(0, { timeout: 15000 })
    await win.screenshot({ animations: 'disabled', path: path.join(OUT, '12-changes.png') })
    await win.getByRole('tab', { name: 'Files' }).click()
    await win.waitForTimeout(300)

    const primary = win.locator('.primary').first()
    if ((await primary.count()) > 0) {
      await primary.click()
      await win.waitForTimeout(500)
      await win.screenshot({ animations: 'disabled', path: path.join(OUT, '04-modal.png') })
      await win.keyboard.press('Escape')
      await win.waitForTimeout(300)
    }

    await win.keyboard.press('Meta+k')
    await win.waitForTimeout(500)
    await win.screenshot({ animations: 'disabled', path: path.join(OUT, '05-palette.png') })
    await win.keyboard.press('Escape')

    // The project menu lives behind the palette's 'New project' command; the
    // sidebar primary is context-sensitive (new workspace once a project exists).
    await win.keyboard.press('Meta+k')
    await win.waitForTimeout(300)
    await win.keyboard.type('new project')
    await win.waitForTimeout(300)
    await win.keyboard.press('Enter')
    await win.waitForTimeout(500)
    await win.screenshot({ animations: 'disabled', path: path.join(OUT, '07-project-menu.png') })
    const gh = win.getByText('Open GitHub project', { exact: false }).first()
    if ((await gh.count()) > 0) {
      await gh.click()
      await win.waitForTimeout(500)
      await win.screenshot({ animations: 'disabled', path: path.join(OUT, '08-clone-modal.png') })
    }
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)

    const rowMenu = win.locator('aside button[aria-haspopup="menu"]').first()
    if ((await rowMenu.count()) > 0) {
      await rowMenu.click()
      await win.waitForTimeout(300)
      await win.screenshot({ animations: 'disabled', path: path.join(OUT, '09-workspace-menu.png') })
      const del = win.getByText('Delete', { exact: false }).first()
      if ((await del.count()) > 0) {
        await del.click()
        await win.waitForTimeout(300)
        await win.screenshot({ animations: 'disabled', path: path.join(OUT, '10-delete-confirm.png') })
        await win.keyboard.press('Escape')
        await win.waitForTimeout(200)
      }
      await win.keyboard.press('Escape')
      await win.waitForTimeout(200)

      // Checkpoints menu: whatever the worktree holds (auto-checkpoints from live
      // turns, or the empty state) is a valid capture; the harness writes no refs.
      await rowMenu.click()
      await win.waitForTimeout(300)
      const cpEntry = win.getByText('Checkpoints', { exact: false }).first()
      if ((await cpEntry.count()) > 0) {
        await cpEntry.click()
        await win.waitForTimeout(400)
        await win.screenshot({ animations: 'disabled', path: path.join(OUT, '13-checkpoints.png') })
        await win.keyboard.press('Escape')
        await win.waitForTimeout(200)
      }
      await win.keyboard.press('Escape')
      await win.waitForTimeout(200)
    }

    const settings = win.getByText('Settings', { exact: true }).first()
    if ((await settings.count()) > 0) {
      await settings.click()
      await win.waitForTimeout(500)
      await win.screenshot({ animations: 'disabled', path: path.join(OUT, '06-settings.png') })
      const prompts = win.getByText('Project prompts', { exact: false }).first()
      if ((await prompts.count()) > 0) {
        await prompts.scrollIntoViewIfNeeded()
        await win.waitForTimeout(300)
        await win.screenshot({ animations: 'disabled', path: path.join(OUT, '14-project-prompts.png') })
      }
    }

    await wsRow.click()
    await win.locator('.session-tab .tab-main').first().click()
    const workspaceName = (await wsRow.textContent())!.trim()
    const sessionId = await win.evaluate(async (name) => {
      const { loom } = globalThis as unknown as { loom: LoomApi }
      for (const project of await loom.projects.list()) {
        const workspace = (await loom.workspaces.list(project.id)).find((w) => w.name === name)
        if (workspace !== undefined) return (await loom.sessions.list(workspace.id))[0]!.id
      }
      throw new Error('seeded workspace missing')
    }, workspaceName)
    await auditLiveTranscript(app, win, sessionId)
    await auditRecentChats(win)
  } finally {
    await app.close()
    rmSync(profile, { recursive: true, force: true })
  }
})

/** Transient IPC events exercise the real renderer without sending prompts or persisting fixtures. */
async function auditRecentChats(win: Page): Promise<void> {
  const tabs = win.locator('.session-tab')
  const before = await tabs.count()
  if (before === 0) return
  await tabs.first().locator('.tab-close').click()
  await win.waitForTimeout(300)
  expect(await tabs.count()).toBe(before - 1)
  const trigger = win.locator('[aria-label="Recent chats"]')
  await expect(trigger).toBeEnabled()
  await trigger.click()
  await win.waitForTimeout(400)
  await win.screenshot({ animations: 'disabled', path: path.join(OUT, '11b-recent-chats.png') })
  // Keyboard contract from the round-8 brief: Enter reopens the active (first) row.
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
  expect(await tabs.count()).toBe(before)
}

async function auditLiveTranscript(app: ElectronApplication, win: Page, sessionId: string): Promise<void> {
  const emit = async (event: AgentEvent) => {
    await app.evaluate(
      ({ BrowserWindow }, push) => {
        BrowserWindow.getAllWindows()[0]!.webContents.send('session:event', push)
      },
      { sessionId, event }
    )
  }
  const turnId = 'round7-visual-audit'
  await emit({ type: 'user.text', turnId: 'round7-user', text: 'Review the transcript rendering.' })
  await emit({ type: 'turn.started', turnId, at: Date.now() })
  const list = win.locator('.chat-list')
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await expect(win.locator('.chat-thinking')).toContainText('Thinking…')
  await expect(win.locator('.chat-thinking')).toContainText('1s')
  await win.screenshot({ animations: 'disabled', path: path.join(OUT, '02d-thinking.png') })
  await emit({
    type: 'tool.call',
    turnId,
    callId: 'audit-grep',
    name: 'grep',
    args: { pattern: 'turnId', dir: 'src/renderer/components/chat' }
  })
  await expect(win.locator('.chat-spinner')).toBeVisible()
  const group = win.locator('.chat-group-head').last()
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await win.screenshot({ animations: 'disabled', path: path.join(OUT, '02e-tool-running.png') })
  await win.emulateMedia({ reducedMotion: 'reduce' })
  expect(
    await win
      .locator('.chat-spinner')
      .evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).animationName)
  ).toBe('none')
  await win.emulateMedia({ reducedMotion: 'no-preference' })
  await emit({ type: 'tool.result', turnId, callId: 'audit-grep', ok: true, output: '(no matches)' })
  await expect(win.locator('.chat-spinner')).toHaveCount(0)
  await expect(win.locator('.chat-tool').last()).toContainText('no matches')
  await expect(win.locator('.chat-tool-ok').last()).toBeVisible()
  await emit({
    type: 'tool.call',
    turnId,
    callId: 'audit-bash',
    name: 'bash',
    args: { command: 'pnpm typecheck' }
  })
  await emit({
    type: 'tool.result',
    turnId,
    callId: 'audit-bash',
    ok: false,
    output: 'Command exited with code 1\nSee details below.'
  })
  await expect(win.locator('.chat-error-row').last()).toContainText('Command exited with code 1')
  await emit({ type: 'text.delta', turnId, text: '```ts\nconst file = "src/a.ts"\n```' })
  const caret = win.locator('.chat-turn').last().locator('.chat-caret')
  await expect(caret).toBeVisible()
  await win.emulateMedia({ reducedMotion: 'reduce' })
  expect(await caret.evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).animationName)).toBe(
    'none'
  )
  await win.emulateMedia({ reducedMotion: 'no-preference' })
  await emit({
    type: 'text.done',
    turnId,
    text: '**Transcript review**\n\n| Surface | Result |\n|---|---|\n| Markdown | Rendered |\n| Tools | Scannable |\n\n- Inline `turnId` chip\n- File opener: src/renderer/components/chat/MessageList.tsx:48\n\n- [x] Completed check\n\n``src/a.ts ` code``\n\n````ts\nconst file = "src/b.ts"\n```\n````\n\n[README.md][readme]\n\n[readme]: README.md\n\n[Malformed](bad%file.ts)'
  })
  await expect(win.locator('.chat-turn').last().locator('table')).toBeVisible()
  await expect(win.locator('.chat-turn').last().locator('input')).toHaveCount(0)
  await expect(
    win.getByTitle('Open src/renderer/components/chat/MessageList.tsx:48', { exact: true })
  ).toBeVisible()
  await expect(win.getByTitle('Open README.md', { exact: true })).toBeAttached()
  await expect(win.locator('.chat-md code button')).toHaveCount(0)
  expect(
    await win
      .locator('.chat-turn')
      .last()
      .locator('.chat-caret')
      .evaluate(
        (el) => el.ownerDocument.defaultView!.getComputedStyle(el.previousElementSibling!, '::after').content
      )
  ).toBe('""')
  await win.emulateMedia({ reducedMotion: 'reduce' })
  expect(
    await caret.evaluate(
      (el) =>
        el.ownerDocument.defaultView!.getComputedStyle(el.previousElementSibling!, '::after').animationName
    )
  ).toBe('none')
  await win.emulateMedia({ reducedMotion: 'no-preference' })
  await win.screenshot({ animations: 'disabled', path: path.join(OUT, '02f-streaming-markdown.png') })
  // A user reading older text must retain their position as the stream grows.
  await list.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0)
  await win.waitForTimeout(100)
  await emit({ type: 'text.delta', turnId, text: '\n\nMore live text.' })
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0)
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await win.waitForTimeout(100)
  await emit({ type: 'text.delta', turnId, text: '\n\n' + 'Live update.\n\n'.repeat(8) })
  await expect
    .poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(2)
  await emit({ type: 'turn.done', turnId, stopReason: 'end', at: Date.now() })
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(win.locator('.chat-turn').last().locator('.chat-meta')).toContainText(' · ')
  await group.click()
  await win.screenshot({ animations: 'disabled', path: path.join(OUT, '02g-tools-completed.png') })
}
