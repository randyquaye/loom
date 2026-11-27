import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { registerBackend } from '../src/main/agents/registry'
import { createEventQueue } from '../src/main/agents/queue'
import { setEnvSecretStore } from '../src/main/env/vars'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import { startLocalSessionMessaging } from '../src/main/sessions/local-messaging'
import { sqliteQueueStore } from '../src/main/sessions/queue-store'
import * as service from '../src/main/sessions/service'

vi.mock('node-pty', () => ({}))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-local-messaging-'))
  const filename = path.join(root, 'loom.db')
  let db = openDb(filename)
  db.prepare("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project',?,0)").run(root)
  for (const id of ['source', 'target']) {
    db.prepare(
      "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,state) VALUES (?,'p',?,?,?,0,'ready')"
    ).run(id, id, `loom/${id}`, root)
  }
  setEnvSecretStore(createSecretStore(path.join(root, 'secrets.enc'), aesGcmCipher(randomBytes(32))))
  const environments = new Map<string, Record<string, string>>()
  const sent = new Map<string, string[]>()
  registerBackend({
    id: 'qwen',
    kind: 'loop',
    authStatus: async () => ({ state: 'ready' }),
    listModels: async () => [],
    startSession: async (options) => {
      const events = createEventQueue()
      environments.set(options.workspaceId, options.env ?? {})
      sent.set(options.workspaceId, [])
      return {
        send: async (text) => {
          sent.get(options.workspaceId)!.push(text)
        },
        cancel: async () => {},
        close: async () => {
          events.end()
        },
        events: events.iterable
      }
    }
  })
  const create = (workspaceId: string) =>
    service.createSession(
      db,
      { workspaceId, backend: 'qwen', model: 'test', effort: 'medium', title: workspaceId },
      'Test instructions'
    )
  const source = create('source')
  const target = create('target')
  service.persistQueues(sqliteQueueStore(db))
  let close = await startLocalSessionMessaging(db)
  cleanup.push(async () => {
    close()
    service.closeAllSessions(db)
    await new Promise((resolve) => setImmediate(resolve))
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  await service.sendTurn(db, source.id, 'Ask the target for a status update')
  const request = (workspace: string, body?: unknown) => {
    const env = environments.get(workspace)!
    return fetch(env.LOOM_MESSAGE_URL!, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${env.LOOM_MESSAGE_TOKEN}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  }
  return {
    get db() {
      return db
    },
    source,
    target,
    environments,
    sent,
    request,
    async restart() {
      close()
      service.closeAllSessions(db)
      await new Promise((resolve) => setImmediate(resolve))
      db.close()
      db = openDb(filename)
      service.closeInterruptedTurns(db)
      service.persistQueues(sqliteQueueStore(db))
      close = await startLocalSessionMessaging(db)
    }
  }
}

it('connects desktop agent processes through authenticated loopback messaging without a cloud account', async () => {
  const h = await fixture()
  const env = h.environments.get('source')!
  expect(new URL(env.LOOM_MESSAGE_URL!).hostname).toBe('127.0.0.1')
  expect((await fetch(env.LOOM_MESSAGE_URL!)).status).toBe(401)
  expect(
    (
      await fetch(env.LOOM_MESSAGE_URL!, {
        headers: { Authorization: `Bearer ${env.LOOM_MESSAGE_TOKEN}`, Origin: 'https://untrusted.example' }
      })
    ).status
  ).toBe(403)
  const discovered = await h.request('source')
  expect(await discovered.json()).toEqual([expect.objectContaining({ id: h.target.id })])
  const id = randomUUID()
  expect((await h.request('source', { id, to: h.target.id, text: 'How is it going?' })).status).toBe(200)
  await vi.waitFor(() => expect(h.sent.get('target')).toHaveLength(1))
  expect(h.sent.get('target')![0]).toContain('not the human')
  expect((await h.request('target', { id: randomUUID(), replyTo: id, text: 'Almost done' })).status).toBe(200)
  expect(service.sessionQueue(h.source.id)).toHaveLength(1)
})

it('restores accepted local messages as waiting after desktop restart without executing them', async () => {
  const h = await fixture()
  await service.sendTurn(h.db, h.target.id, 'Keep working')
  const id = randomUUID()
  expect((await h.request('source', { id, to: h.target.id, text: 'Status?' })).status).toBe(200)
  const previousUrl = h.environments.get('source')!.LOOM_MESSAGE_URL!
  const deliveries = h.sent.get('target')!.length
  await h.restart()
  expect(service.sessionQueue(h.target.id)).toMatchObject([{ id }])
  expect(service.sessionActivity().bySession[h.target.id]).toBeUndefined()
  expect(h.sent.get('target')).toHaveLength(deliveries)
  await expect(fetch(previousUrl)).rejects.toThrow()
})
