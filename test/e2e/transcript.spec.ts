import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, _electron } from '@playwright/test'
import { openDb } from '../../src/main/db'

const TRANSCRIPT = [
  'Here is the fix:',
  '',
  '```ts',
  'export const answer = 42',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A[prompt] --> B[agent]',
  '```',
  '',
  'See [the docs](https://example.com/docs) or [mail](mailto:person@example.com).'
].join('\n')

/**
 * Seeds a ready workspace with one session whose reply carries a code fence and a mermaid
 * fence, then checks the transcript chrome: copy action on code, a rendered diagram, and ⌘T
 * opening a fresh compose tab exactly like the tab strip's +.
 */
test('transcript renders code copy actions and mermaid diagrams; ⌘T opens a new session tab', async () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'loom-transcript-'))
  const worktree = mkdtempSync(path.join(tmpdir(), 'loom-transcript-wt-'))
  const db = openDb(path.join(profile, 'loom.db'))
  db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
    'p1',
    'demo',
    worktree,
    1
  )
  db.prepare(
    `INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('w1', 'p1', 'transcript-demo', 'loom/transcript-demo', worktree, 1, 'ready')
  db.prepare(
    'INSERT INTO sessions (id, workspace_id, backend, model, effort, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('s1', 'w1', 'qwen', 'qwen3-max', 'medium', 'code and diagram', 1)
  db.prepare('INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)').run(
    's1',
    1,
    1,
    'user.text',
    JSON.stringify({ type: 'user.text', turnId: 't1', text: 'show me the fix' })
  )
  db.prepare('INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)').run(
    's1',
    2,
    2,
    'turn.started',
    JSON.stringify({ type: 'turn.started', turnId: 't1', at: 2 })
  )
  db.prepare('INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)').run(
    's1',
    3,
    3,
    'text.done',
    JSON.stringify({ type: 'text.done', turnId: 't1', text: TRANSCRIPT })
  )
  // Without turn.done the transcript reads the turn as still streaming, and mermaid fences
  // deliberately stay as code until a reply completes.
  db.prepare('INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)').run(
    's1',
    4,
    4,
    'turn.done',
    JSON.stringify({ type: 'turn.done', turnId: 't1', stopReason: 'end', at: 4 })
  )
  db.close()

  const app = await _electron.launch({
    args: [path.join(__dirname, '../../out/main/index.js'), `--user-data-dir=${profile}`],
    env: { ...process.env, LOOM_DATA_DIR: profile }
  })
  try {
    const win = await app.firstWindow()
    await win.locator('.home-card', { hasText: 'transcript-demo' }).click()
    await win.locator('.session-tab', { hasText: 'code and diagram' }).click()

    const fence = win.locator('.chat-code')
    await expect(fence).toBeVisible()
    await expect(fence.locator('.chat-code-lang')).toHaveText('ts')
    const copy = fence.locator('.chat-code-copy')
    await expect(copy).toBeVisible()
    await copy.click()
    await expect(copy).toHaveText('Copied')

    await expect(win.locator('.chat-mermaid svg')).toBeVisible()

    // Web links are clickable controls that leave through the OS browser; other schemes
    // stay inert text. No click here: e2e must not launch the user's browser.
    const weblink = win.locator('button.chat-weblink', { hasText: 'the docs' })
    await expect(weblink).toBeVisible()
    await expect(weblink).toHaveAttribute('title', /Open in your browser/)
    await expect(win.locator('button.chat-weblink', { hasText: 'mail' })).toHaveCount(0)
    await expect(win.locator('.chat-md-link', { hasText: 'mail' })).toBeVisible()

    // Press-to-talk without a stored key reports the missing credential instead of capturing.
    const talk = win.locator('.talk-btn')
    await talk.hover()
    await win.mouse.down()
    await win.mouse.up()
    await expect(win.locator('.toast', { hasText: 'ElevenLabs API key required' })).toBeVisible()

    await win.keyboard.press('Meta+t')
    await expect(win.locator('.tab-draft')).toBeVisible()

    // The compose empty state carries the monochrome weave mark, not the old grey sphere.
    // MessageList keeps a hidden fallback copy while the start composer is mounted.
    await expect(win.locator('.composer-start-empty svg.empty-mark')).toBeVisible()
  } finally {
    await app.close()
    rmSync(profile, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  }
})
