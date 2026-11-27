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
import { createSessionMessaging } from '../src/main/sessions/messaging'
import { sqliteQueueStore } from '../src/main/sessions/queue-store'
import * as service from '../src/main/sessions/service'

vi.mock('node-pty', () => ({}))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-peer-delivery-'))
  const db = openDb(':memory:')
  db.exec(
    "INSERT INTO users(id,email,created_at) VALUES ('owner','owner@example.com',0),('other','other@example.com',0)"
  )
  db.prepare("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project',?,0)").run(root)
  for (const id of ['source', 'target']) {
    db.prepare(
      "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id,state) VALUES (?,'p',?,?,?,0,'owner','ready')"
    ).run(id, id, `loom/${id}`, root)
  }
  setEnvSecretStore(createSecretStore(path.join(root, 'secrets.enc'), aesGcmCipher(randomBytes(32))))
  service.persistQueues(sqliteQueueStore(db))
  const streams = new Map<string, ReturnType<typeof createEventQueue>>()
  const sent = new Map<string, string[]>()
  const control = vi.fn()
  registerBackend({
    id: 'qwen',
    kind: 'loop',
    authStatus: async () => ({ state: 'ready' }),
    listModels: async () => [],
    startSession: async (opts) => {
      const events = createEventQueue()
      streams.set(opts.workspaceId, events)
      sent.set(opts.workspaceId, [])
      return {
        send: async (text) => {
          sent.get(opts.workspaceId)!.push(text)
        },
        steer: control,
        cancel: control,
        answerQuestion: control,
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
      {
        workspaceId,
        backend: 'qwen',
        model: 'test',
        effort: 'medium',
        title: workspaceId
      },
      'Test instructions'
    )
  const source = create('source')
  const target = create('target')
  const messaging = createSessionMessaging({
    db,
    url: () => 'http://127.0.0.1:9999',
    isAdmitted: (id) => id === 'owner',
    active: (id) => service.sessionActivity().bySession[id] !== undefined,
    receive: (id, input) => service.receiveSessionMessage(db, id, input)
  })
  service.setSessionMessaging(messaging)
  cleanup.push(async () => {
    service.closeAllSessions(db)
    service.setSessionMessaging(null)
    for (const stream of streams.values()) stream.end()
    await new Promise((resolve) => setImmediate(resolve))
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  await service.sendTurn(db, source.id, 'Ask the target for a status update')
  const input = { id: randomUUID(), to: target.id, text: 'How is the migration going?' }
  const send = () =>
    messaging.routes.request('/session-messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${messaging.environment(source.id).LOOM_MESSAGE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(input)
    })
  return { db, source, target, streams, sent, control, input, send }
}

it('lets an idle recipient evaluate a message as peer input without human consent', async () => {
  const h = await fixture()
  expect((await h.send()).status).toBe(200)
  await vi.waitFor(() => expect(h.sent.get('target')).toHaveLength(1))
  const event = service.sessionEvents(h.db, h.target.id).find((event) => event.type === 'user.text')
  expect(event).toMatchObject({ peer: { sessionId: h.source.id, messageId: h.input.id } })
  expect(event?.type === 'user.text' && event.actorId).toBeUndefined()
  expect(h.sent.get('target')![0]).toContain('not the human')
  expect(h.control).not.toHaveBeenCalled()
})

it.each([false, true])(
  'preserves a busy recipient and checks queued delivery after revocation=%s',
  async (revoked) => {
    const h = await fixture()
    await service.sendTurn(h.db, h.target.id, 'Keep working on the migration')
    expect((await h.send()).status).toBe(200)
    expect(service.sessionQueue(h.target.id)).toHaveLength(1)
    expect(h.sent.get('target')).toHaveLength(1)
    expect(h.control).not.toHaveBeenCalled()
    if (revoked) h.db.prepare("UPDATE workspaces SET owner_id='other' WHERE id='source'").run()
    h.streams.get('target')!.push({ type: 'turn.done', turnId: 'work', stopReason: 'end' })
    if (revoked) {
      await vi.waitFor(() => expect(service.sessionActivity().bySession[h.target.id]).toBeUndefined())
      expect(h.sent.get('target')).toHaveLength(1)
      expect(service.sessionQueue(h.target.id)).toHaveLength(1)
    } else {
      await vi.waitFor(() => expect(h.sent.get('target')).toHaveLength(2))
      expect(service.sessionQueue(h.target.id)).toEqual([])
    }
    expect(h.control).not.toHaveBeenCalled()
  }
)

it('keeps restored human inputs waiting when a peer messages an idle recipient', async () => {
  const h = await fixture()
  const store = sqliteQueueStore(h.db)
  store.save(h.target.id, [{ id: randomUUID(), text: 'Waiting human work', images: [] }])
  service.persistQueues(store)
  expect((await h.send()).status).toBe(200)
  await new Promise((resolve) => setImmediate(resolve))
  expect(h.sent.get('target')).toBeUndefined()
  expect(service.sessionQueue(h.target.id).map((item) => item.text)).toEqual([
    'Waiting human work',
    expect.stringContaining(h.input.text)
  ])
  expect(h.control).not.toHaveBeenCalled()
})
