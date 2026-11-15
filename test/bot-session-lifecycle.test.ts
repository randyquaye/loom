import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { EventQueue } from '../src/main/agents/queue'
import type { RunningSession } from '../src/main/agents/types'
import type { SessionOpts } from '../src/shared/models'

const cleanup: Array<() => Promise<void>> = []
const tab = {
  workspaceId: 'w1',
  backend: 'qwen',
  model: 'qwen3-max',
  effort: 'medium',
  title: 'bot conversation'
} as const
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function barrier() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}

async function boot() {
  vi.resetModules()
  const root = await mkdtemp(path.join(tmpdir(), 'loom-bot-session-'))
  const { openDb } = await import('../src/main/db')
  const service = await import('../src/main/sessions/service')
  const { registerBackend } = await import('../src/main/agents/registry')
  const { createEventQueue } = await import('../src/main/agents/queue')
  const { setEnvSecretStore } = await import('../src/main/env/vars')
  const { aesGcmCipher, createSecretStore } = await import('../src/main/secrets')
  const { sqliteQueueStore } = await import('../src/main/sessions/queue-store')
  const db = openDb(':memory:')
  db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
    'p1',
    'demo',
    root,
    1
  )
  db.prepare(
    'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('w1', 'p1', 'bot work', 'loom/bot-work', root, 1)
  setEnvSecretStore(createSecretStore(path.join(root, 'secrets.enc'), aesGcmCipher(randomBytes(32))))
  const streams: EventQueue[] = []
  const starts: SessionOpts[] = []
  const sent: string[] = []
  let starting: Promise<void> | undefined
  registerBackend({
    id: 'qwen',
    kind: 'loop',
    authStatus: async () => ({ state: 'ready' }),
    listModels: async () => [],
    startSession: async (opts) => {
      const stream = createEventQueue()
      streams.push(stream)
      starts.push(opts)
      const session: RunningSession = {
        send: async (text) => {
          sent.push(text)
        },
        steer: vi.fn().mockResolvedValue(undefined),
        cancel: async () => {},
        close: async () => {
          stream.end()
        },
        providerSessionId: () => 'native-bot-thread',
        events: stream.iterable
      }
      await starting
      return session
    }
  })
  service.persistQueues(sqliteQueueStore(db))
  cleanup.push(async () => {
    service.setTurnStartGuard(null)
    service.closeAllSessions()
    for (const stream of streams) stream.end()
    await flush()
    if (db.open) db.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    db,
    service,
    streams,
    starts,
    sent,
    holdStart: (wait: Promise<void>) => {
      starting = wait
    },
    reloadQueue: () => service.persistQueues(sqliteQueueStore(db)),
    create: () => service.createSession(db, tab, 'immutable bot instructions')
  }
}

it('retains the requesting human in transcript and durable queued input after reload', async () => {
  const h = await boot()
  const session = h.create()
  await h.service.sendTurn(h.db, session.id, 'active', [], [], 'message-a', 'alice')
  await h.service.sendTurn(h.db, session.id, 'waiting', [], [], 'message-b', 'bob')
  const active = h.service.sessionEvents(h.db, session.id).find((event) => event.type === 'user.text')
  expect(active).toMatchObject({ text: 'active', actorId: 'alice' })
  h.service.closeAllSessions()
  h.reloadQueue()
  const saved = h.db.prepare('SELECT payload FROM queued_messages WHERE id = ?').get('message-b') as {
    payload: string
  }
  expect(JSON.parse(saved.payload)).toMatchObject({ actorId: 'bob', messageId: 'message-b', text: 'waiting' })
  expect(h.service.sessionQueue(session.id)).toEqual([{ id: 'message-b', text: 'waiting' }])
})

it('rechecks the human grant after asynchronous provider startup before dispatch', async () => {
  const h = await boot()
  const session = h.create()
  const startup = barrier()
  h.holdStart(startup.wait)
  let allowed = true
  const check = vi.fn((_workspaceId: string, _actorId?: string) => {
    if (!allowed) throw new Error('Controller access was revoked')
  })
  h.service.setTurnStartGuard(check)
  const sending = h.service.sendTurn(h.db, session.id, 'do work', [], [], 'message-a', 'alice')
  try {
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    allowed = false
    startup.release()
    await sending
    expect(h.sent).toEqual([])
    expect(check).toHaveBeenLastCalledWith('w1', 'alice')
    expect(h.service.sessionEvents(h.db, session.id)).toContainEqual(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('revoked') })
    )
  } finally {
    startup.release()
    await sending
  }
})

it('keeps a revoked queued request waiting instead of dispatching under another controller', async () => {
  const h = await boot()
  const session = h.create()
  let bobAllowed = true
  h.service.setTurnStartGuard((_workspaceId, actorId) => {
    if (actorId === 'bob' && !bobAllowed) throw new Error('Bob was removed')
  })
  await h.service.sendTurn(h.db, session.id, 'active', [], [], 'message-a', 'alice')
  h.streams[0]!.push({ type: 'turn.started', turnId: 'provider-a', at: 1 })
  await flush()
  await h.service.sendTurn(h.db, session.id, 'waiting', [], [], 'message-b', 'bob')
  h.service.closeAllSessions()
  h.reloadQueue()
  bobAllowed = false
  await h.service.sendTurn(h.db, session.id, 'explicit continuation', [], [], 'message-c', 'alice')
  h.streams[1]!.push({ type: 'turn.started', turnId: 'provider-c', at: 2 })
  h.streams[1]!.push({ type: 'turn.done', turnId: 'provider-c', stopReason: 'end' })
  await flush()
  await flush()
  expect(h.sent).toEqual(['active', 'explicit continuation'])
  expect(h.service.sessionQueue(session.id)).toEqual([{ id: 'message-b', text: 'waiting' }])
})

it('stops current and queued work without closing the conversation or draining late events', async () => {
  const h = await boot()
  const session = h.create()
  await h.service.sendTurn(h.db, session.id, 'active', [], [], 'message-a', 'alice')
  await h.service.sendTurn(h.db, session.id, 'waiting', [], [], 'message-b', 'alice')
  const { beginDelivery } = await import('../src/main/sessions/deliveries')
  beginDelivery(
    h.db,
    session.id,
    { text: 'pending', images: [], messageId: 'message-p', actorId: 'alice' },
    'send'
  )
  h.service.stopSessionWork(h.db, session.id)
  h.streams[0]!.push({ type: 'turn.done', turnId: 'late', stopReason: 'cancelled' })
  await flush()
  expect(h.sent).toEqual(['active'])
  expect(h.service.sessionQueue(session.id)).toEqual([])
  expect(h.db.prepare('SELECT 1 FROM queued_messages WHERE session_id = ?').get(session.id)).toBeUndefined()
  expect(
    h.db.prepare('SELECT 1 FROM pending_deliveries WHERE session_id = ?').get(session.id)
  ).toBeUndefined()
  expect(h.service.listSessions(h.db, 'w1')).toContainEqual(
    expect.objectContaining({ id: session.id, closedAt: null, providerSessionId: 'native-bot-thread' })
  )
  expect(h.service.sessionEvents(h.db, session.id)).toContainEqual(
    expect.objectContaining({ type: 'turn.done', stopReason: 'cancelled' })
  )
  await h.service.sendTurn(h.db, session.id, 'resume explicitly', [], [], 'message-c', 'alice')
  expect(h.sent).toEqual(['active', 'resume explicitly'])
  expect(h.starts[1]).toMatchObject({ resumeId: 'native-bot-thread' })
})

it('stops startup work before a delayed provider can dispatch its accepted prompt', async () => {
  const h = await boot()
  const session = h.create()
  const startup = barrier()
  h.holdStart(startup.wait)
  const sending = h.service.sendTurn(h.db, session.id, 'active', [], [], 'message-a', 'alice')
  try {
    await vi.waitFor(() => expect(h.starts).toHaveLength(1))
    h.service.stopSessionWork(h.db, session.id)
    startup.release()
    await sending
    expect(h.sent).toEqual([])
    expect(h.service.listSessions(h.db, 'w1')).toContainEqual(expect.objectContaining({ id: session.id }))
  } finally {
    startup.release()
    await sending
  }
})

it('uses the reserved conversation identity when admission and execution happen separately', async () => {
  const h = await boot()
  const reservedId = 'reserved-before-workspace-setup'
  const session = h.service.createSession(h.db, tab, 'immutable bot instructions', reservedId)
  await h.service.sendTurn(h.db, reservedId, 'accepted request', [], [], 'message-a', 'alice')
  expect(session.id).toBe(reservedId)
  expect(h.service.sessionEvents(h.db, reservedId)).toContainEqual(
    expect.objectContaining({ type: 'user.text', text: 'accepted request', actorId: 'alice' })
  )
  expect(() => h.service.createSession(h.db, tab, 'replacement', reservedId)).toThrow()
})

it('never rewrites bot context from the host after workspace code can replace the context directory', async () => {
  const h = await boot()
  const outside = await mkdtemp(path.join(tmpdir(), 'loom-bot-context-outside-'))
  h.db.prepare('INSERT INTO users(id,email,created_at) VALUES (?,?,?)').run('bot', 'bot@loom.invalid', 1)
  h.db
    .prepare(
      "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES ('bot','member','bot','active',1)"
    )
    .run()
  h.db.prepare("UPDATE workspaces SET owner_id='bot' WHERE id='w1'").run()
  await symlink(outside, path.join(h.root, '.context'))
  try {
    const session = h.create()
    await h.service.sendTurn(h.db, session.id, 'first bot request', [], [], 'message-a', 'alice')
    h.service.stopSessionWork(h.db, session.id)
    await h.service.sendTurn(h.db, session.id, 'explicit continuation', [], [], 'message-b', 'alice')
    expect(h.sent).toEqual(['first bot request', 'explicit continuation'])
    expect(await readdir(outside)).toEqual([])
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})
