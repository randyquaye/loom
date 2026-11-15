import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, _electron, type ElectronApplication } from '@playwright/test'
import { openDb } from '../../src/main/db'

test('file references and inline screenshots repeatedly activate the existing viewer', async () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'loom-previews-'))
  const worktree = mkdtempSync(path.join(tmpdir(), 'loom-previews-wt-'))
  mkdirSync(path.join(worktree, '.context'))
  writeFileSync(path.join(worktree, 'README.md'), '# Preview fixture\n')
  writeFileSync(
    path.join(worktree, '.context', 'screen shot.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=',
      'base64'
    )
  )
  const db = openDb(path.join(profile, 'loom.db'))
  db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
    'p',
    'demo',
    worktree,
    1
  )
  db.prepare(
    `INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at, state)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('w', 'p', 'preview-demo', 'loom/previews', worktree, 1, 'ready')
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, backend, model, effort, title, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('s', 'w', 'qwen', 'qwen3-max', 'medium', 'screenshots', 1)
  const text = [
    'See README.md for details.',
    '',
    '![Desktop preview](.context/screen%20shot.png)',
    '',
    '![Missing preview](.context/missing.png)'
  ].join('\n')
  const events = [
    { type: 'user.text', turnId: 't', text: 'show the screenshots' },
    { type: 'text.done', turnId: 't', text },
    { type: 'turn.done', turnId: 't', stopReason: 'end', at: 3 }
  ]
  for (const [index, event] of events.entries()) {
    db.prepare('INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)').run(
      's',
      index + 1,
      index + 1,
      event.type,
      JSON.stringify(event)
    )
  }
  db.close()
  let app: ElectronApplication | undefined
  try {
    app = await _electron.launch({
      args: [path.join(__dirname, '../../out/main/index.js'), `--user-data-dir=${profile}`],
      env: { ...process.env, LOOM_DATA_DIR: profile }
    })
    const win = await app.firstWindow()
    await win.locator('.home-card', { hasText: 'preview-demo' }).click()
    const chat = win.locator('.session-tab', { hasText: 'screenshots' })
    await chat.click()
    const screenshot = win.locator('.chat-md img[alt="Desktop preview"]')
    await expect(screenshot).toBeVisible()
    expect(await screenshot.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth)).toBe(
      1
    )
    await expect(win.locator('.chat-md', { hasText: 'Missing preview' })).toContainText('Cannot preview')
    await win.screenshot({ path: test.info().outputPath('chat-previews.png') })

    for (let attempt = 0; attempt < 2; attempt++) {
      await win.locator('button.tree-row', { hasText: 'README.md' }).click()
      await expect(win.locator('.viewer-host')).toBeVisible()
      await chat.click()
      await win.locator('button.chat-filelink', { hasText: 'README.md' }).click()
      await expect(win.locator('.viewer-host')).toBeVisible()
      await chat.click()
      await screenshot.click()
      await expect(win.locator('.image-view img')).toBeVisible()
      if (attempt === 0) await win.screenshot({ path: test.info().outputPath('image-viewer.png') })
      await chat.click()
    }
  } finally {
    await app?.close()
    rmSync(profile, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  }
})
