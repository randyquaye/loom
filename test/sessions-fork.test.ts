import { mkdtempSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { registerBackend } from '../src/main/agents/registry'
import type { AgentBackend, RunningSession } from '../src/main/agents/types'
import { openDb } from '../src/main/db'
import { setEnvSecretStore } from '../src/main/env/vars'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import { createSession, forkSession, sendTurn, sessionEvents } from '../src/main/sessions/service'

// workspaceEnv reads the env-var overlay from the secret store; tests wire a throwaway one.
beforeEach(() => {
  setEnvSecretStore(
    createSecretStore(
      path.join(mkdtempSync(path.join(tmpdir(), 'loom-env-fork-')), 'secrets.enc'),
      aesGcmCipher(randomBytes(32))
    )
  )
})

function seed() {
  const wt = mkdtempSync(path.join(tmpdir(), 'loom-fork-'))
  const db = openDb(':memory:')
  db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
    'p1',
    'demo',
    '/tmp/demo',
    1
  )
  db.prepare(
    'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('w1', 'p1', 'ws', 'loom/ws', wt, 1)
  return { db, wt }
}

function registerSilentBackend() {
  const backend: AgentBackend = {
    id: 'qwen',
    kind: 'loop',
    authStatus: async () => ({ state: 'ready' }),
    listModels: async () => [],
    startSession: async (): Promise<RunningSession> => ({
      send: async () => {},
      cancel: async () => {},
      close: async () => {},
      events: (async function* () {})()
    })
  }
  registerBackend(backend)
}

describe('forkSession', () => {
  it('seeds a new session pointing at a transcript attachment and links it', async () => {
    const { db, wt } = seed()
    registerSilentBackend()
    const source = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'source'
    })
    await sendTurn(db, source.id, 'original question')
    db.prepare('INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)').run(
      source.id,
      2,
      2,
      'text.done',
      JSON.stringify({ type: 'text.done', turnId: 't', text: 'original answer' })
    )

    const forked = await forkSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      sourceSessionId: source.id
    })

    expect(forked.forkedFrom).toBe(source.id)
    // The seeded turn is sent fire-and-forget so the fork returns immediately.
    const deadline = Date.now() + 2000
    while (Date.now() < deadline && sessionEvents(db, forked.id).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const first = sessionEvents(db, forked.id)[0]
    expect(first?.type).toBe('user.text')
    if (first?.type === 'user.text') {
      expect(first.text).toContain('.context/attachments/')
      expect(first.text).toContain('Transcript of')
      expect(first.text).not.toContain('original answer')
    }

    const attachments = await readdir(path.join(wt, '.context', 'attachments'))
    expect(attachments).toHaveLength(1)
    const body = await readFile(path.join(wt, '.context', 'attachments', attachments[0]!), 'utf8')
    expect(body).toContain('original question')
    expect(body).toContain('original answer')
    // sendTurn materializes the workspace context blob alongside.
    await expect(readFile(path.join(wt, '.context', 'loom.context'), 'utf8')).resolves.toContain(
      'workspace: ws'
    )
  })
})
