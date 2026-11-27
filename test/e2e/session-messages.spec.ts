import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, _electron } from '@playwright/test'
import { openDb } from '../../src/main/db'
import type { AgentEvent } from '../../src/shared/events'
import type { LoomApi } from '../../src/shared/ipc-contract'

test('peer input is distinct from human text, folds independently, and opens its exact source session', async ({}, info) => {
  const profile = mkdtempSync(path.join(tmpdir(), 'loom-peer-ui-'))
  const worktree = mkdtempSync(path.join(tmpdir(), 'loom-peer-ui-wt-'))
  const sourceId = 'a4f70c2b-6d18-4f29-8fb0-e1c9a34702d5'
  const recipientId = '8c2f1a34-7fb9-4afe-93a3-3cdbe642ab81'
  const body = 'The search patch is ready. Are the keyboard navigation checks passing?'
  const title = 'Add project search'
  const at = Date.now()
  const db = openDb(path.join(profile, 'loom.db'))
  db.prepare('INSERT INTO projects(id,name,repo_path,created_at) VALUES (?,?,?,?)').run(
    'p',
    'notes',
    worktree,
    at
  )
  for (const [id, name] of [
    ['source', 'add-project-search'],
    ['recipient', 'fix-keyboard-navigation']
  ]) {
    db.prepare(
      "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,state) VALUES (?,'p',?,?,?,?,'ready')"
    ).run(id, name, `loom/${name}`, worktree, at)
  }
  for (const [id, workspace, name] of [
    ['decoy', 'source', title],
    [sourceId, 'source', title],
    [recipientId, 'recipient', 'Keyboard navigation']
  ]) {
    db.prepare(
      "INSERT INTO sessions(id,workspace_id,backend,model,effort,title,created_at) VALUES (?,?,'qwen','qwen3-max','medium',?,?)"
    ).run(id, workspace, name, at)
  }
  function history(sessionId: string, events: AgentEvent[]) {
    events.forEach((event, index) => {
      db.prepare('INSERT INTO events(session_id,seq,ts,type,payload) VALUES (?,?,?,?,?)').run(
        sessionId,
        index + 1,
        at + index,
        event.type,
        JSON.stringify(event)
      )
    })
  }
  history(sourceId, [{ type: 'user.text', turnId: 'source-turn', text: 'The actual source transcript' }])
  history('decoy', [
    { type: 'user.text', turnId: 'decoy-turn', text: 'A different session with the same name' }
  ])
  history(recipientId, [
    { type: 'user.text', turnId: 'human', text: `Message from session ${sourceId}:\nA human wrote this.` },
    { type: 'turn.started', turnId: 'human-provider', at },
    { type: 'text.done', turnId: 'human-provider', text: 'I remain in control of this session.' },
    { type: 'turn.done', turnId: 'human-provider', stopReason: 'end', at },
    {
      type: 'user.text',
      turnId: 'peer',
      text: `Message from session ${sourceId} (${title}):\n${body}`,
      peer: { messageId: 'message', sessionId: sourceId, workspaceId: 'source', rootId: 'root', title, body }
    },
    { type: 'turn.started', turnId: 'peer-provider', at },
    {
      type: 'text.done',
      turnId: 'peer-provider',
      text: 'The focus checks pass. I am verifying the last shortcut before replying.'
    },
    { type: 'turn.done', turnId: 'peer-provider', stopReason: 'end', at }
  ])
  db.close()

  const env: Record<string, string> = { ...process.env, LOOM_DATA_DIR: profile }
  delete env.LOOM_RUNNER_URL
  delete env.LOOM_RUNNER_TOKEN
  const app = await _electron.launch({
    args: [path.join(__dirname, '../../out/main/index.js'), `--user-data-dir=${profile}`],
    env
  })
  try {
    const win = await app.firstWindow()
    const tabs = win.getByRole('tablist', { name: 'Sessions', exact: true })
    await win.locator('.home-card', { hasText: 'fix-keyboard-navigation' }).click()
    const peer = win.locator('.chat-peer')
    await expect(peer).toHaveCount(1)
    await expect(win.locator('.chat-user')).toContainText('A human wrote this.')
    await expect(peer.locator('.chat-peer-body')).toHaveText(body)
    await expect(peer.locator('time')).toBeVisible()
    await expect(peer.locator('.chat-peer-id')).toHaveText('a4f70c')
    await expect(tabs).not.toContainText('8c2f1a')
    await win.screenshot({ path: info.outputPath('peer-expanded.png') })

    const disclosure = peer.locator('summary')
    await disclosure.focus()
    await win.keyboard.press('Enter')
    await expect(peer.locator('.chat-peer-body')).toBeHidden()
    await expect(win.getByText('The focus checks pass.', { exact: false })).toBeVisible()
    await win.screenshot({ path: info.outputPath('peer-collapsed.png') })

    // A source name is a separate control: navigation must not expand the interaction.
    await peer.getByRole('button', { name: `Open session ${title}` }).focus()
    await win.keyboard.press('Enter')
    await expect(win.locator('.chat-user')).toHaveText('The actual source transcript')
    await expect(tabs.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('aria-label', title)
    await win.locator('.ws-row', { hasText: 'fix-keyboard-navigation' }).click()
    await expect(peer).toBeVisible()
    await disclosure.locator('span').click()
    await expect(peer.locator('.chat-peer-body')).toBeHidden()

    // Closing the source must not turn a history link into an implicit reopen.
    await win.evaluate((id) => {
      const { loom } = globalThis as unknown as { loom: LoomApi }
      return loom.sessions.close(id)
    }, sourceId)
    await peer.getByRole('button', { name: `Open session ${title}` }).click()
    await expect(win.locator('.toast', { hasText: 'Source session is closed or unavailable' })).toBeVisible()
    await expect(peer).toBeVisible()
    await expect(peer.locator('.chat-peer-body')).toBeHidden()
    expect(
      await win.evaluate(async () => {
        const { loom } = globalThis as unknown as { loom: LoomApi }
        return (await loom.sessions.closed('source')).map((row) => row.id)
      })
    ).toContain(sourceId)
  } finally {
    await app.close()
    rmSync(profile, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  }
})
