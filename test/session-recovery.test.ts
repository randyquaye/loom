import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import type { EventQueue } from '../src/main/agents/queue'
import type { RunningSession } from '../src/main/agents/types'
import type { AgentEvent } from '../src/shared/events'
import type * as ServiceModule from '../src/main/sessions/service'

type Service = typeof ServiceModule
const cleanup: Array<() => Promise<void>> = []
const tab = {
  workspaceId: 'w1',
  backend: 'qwen',
  model: 'qwen3-max',
  effort: 'medium',
  title: 'test'
} as const
const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function boot(existing?: Database.Database) {
  vi.resetModules()
  const root = await mkdtemp(path.join(tmpdir(), 'loom-recovery-'))
  const { openDb } = await import('../src/main/db')
  const service: Service = await import('../src/main/sessions/service')
  const { registerBackend } = await import('../src/main/agents/registry')
  const { createEventQueue } = await import('../src/main/agents/queue')
  const { setEnvSecretStore } = await import('../src/main/env/vars')
  const { aesGcmCipher, createSecretStore } = await import('../src/main/secrets')
  const { sqliteQueueStore } = await import('../src/main/sessions/queue-store')
  const { registerRunnerHandlers } = await import('../src/main/runner/handlers')
  const { createAccess } = await import('../src/main/runner/access')
  const { dispatch } = await import('../src/main/ipc/registry')
  const db = existing ?? openDb(':memory:')
  if (existing === undefined) {
    db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
      'p1',
      'demo',
      root,
      1
    )
    db.prepare(
      'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('w1', 'p1', 'test', 'loom/test', root, 1)
  }
  const secrets = createSecretStore(path.join(root, 'secrets.enc'), aesGcmCipher(randomBytes(32)))
  setEnvSecretStore(secrets)
  const streams: EventQueue[] = []
  const sent: string[] = []
  const sessions: RunningSession[] = []
  let starting: Promise<void> | undefined
  registerBackend({
    id: 'qwen',
    kind: 'loop',
    authStatus: async () => ({ state: 'ready' }),
    listModels: async () => [],
    startSession: async () => {
      const stream = createEventQueue()
      streams.push(stream)
      const session: RunningSession = {
        send: async (text) => {
          sent.push(text)
        },
        cancel: async () => {},
        close: async () => {
          stream.end()
        },
        providerSessionId: () => 'provider-thread',
        events: stream.iterable
      }
      sessions.push(session)
      await starting
      return session
    }
  })
  registerRunnerHandlers(
    { db, dataRoot: root, secrets },
    {
      placement: { checkout: 'clone', runtime: 'machine' },
      allowLocalRemotes: true,
      access: createAccess(db),
      logins: null
    }
  )
  service.persistQueues(sqliteQueueStore(db))
  cleanup.push(async () => {
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
    sent,
    streams,
    sessions,
    holdStart: (promise: Promise<void>) => {
      starting = promise
    },
    create: () => service.createSession(db, tab, 'test instructions'),
    call: (channel: string, sessionId: string, text: string, messageId: string) =>
      Promise.resolve(dispatch(channel, { sessionId, text, attachments: [], messageId }, { userId: 'test' }))
  }
}

function history(db: Database.Database, sessionId: string, events: AgentEvent[]) {
  const insert = db.prepare('INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)')
  events.forEach((event, index) =>
    insert.run(sessionId, index + 1, index + 1, event.type, JSON.stringify(event))
  )
}

it.each(['turn.done', 'error', 'turn.started'] as const)(
  'does not let a late %s of the previous turn settle its successor',
  async (type) => {
    const h = await boot()
    const session = h.create()
    await h.service.sendTurn(h.db, session.id, 'first')
    const stream = h.streams[0]!
    stream.push({ type: 'turn.started', turnId: 'old', at: 1 })
    await flush()
    await h.service.sendTurn(h.db, session.id, 'second')
    stream.push({ type: 'turn.done', turnId: 'old', stopReason: 'end' })
    await vi.waitFor(() => expect(h.sent).toEqual(['first', 'second']))
    await h.service.sendTurn(h.db, session.id, 'third')
    if (type === 'error')
      stream.push({ type, turnId: 'old', code: 'late', message: 'old failure', retryable: false })
    else if (type === 'turn.done') stream.push({ type, turnId: 'old', stopReason: 'error' })
    else stream.push({ type, turnId: 'old', at: 2 })
    await flush()
    expect(h.sent).toEqual(['first', 'second'])
    expect(h.service.sessionQueue(session.id).map((item) => item.text)).toEqual(['third'])
    expect(h.service.sessionActivity().bySession[session.id]).toBe('w1')
    expect(
      h.service
        .sessionEvents(h.db, session.id)
        .filter((event) => event.type === 'turn.started' && event.turnId === 'old')
    ).toHaveLength(1)
    stream.push({ type: 'turn.started', turnId: 'new', at: 3 })
    stream.push({ type: 'turn.done', turnId: 'new', stopReason: 'end' })
    await vi.waitFor(() => expect(h.sent).toEqual(['first', 'second', 'third']))
  }
)

it('does not interrupt a legacy startup failure completed under the agent own ID', async () => {
  const h = await boot()
  const session = h.create()
  history(h.db, session.id, [
    { type: 'user.text', turnId: 'prompt', text: 'hello' },
    { type: 'error', turnId: 'startup', code: 'start', message: 'failed', retryable: false },
    { type: 'turn.done', turnId: 'startup', stopReason: 'error' }
  ])
  const before = h.service.sessionEvents(h.db, session.id)
  expect(h.service.closeInterruptedTurns(h.db)).toBe(0)
  expect(h.service.sessionEvents(h.db, session.id)).toEqual(before)
})

it('records a real start after an earlier retryable startup warning', async () => {
  const h = await boot()
  const session = h.create()
  await h.service.sendTurn(h.db, session.id, 'hello')
  h.streams[0]!.push({
    type: 'error',
    turnId: 'starting',
    code: 'retry',
    message: 'retrying',
    retryable: true
  })
  h.streams[0]!.push({ type: 'turn.started', turnId: 'starting', at: 1 })
  await flush()
  expect(
    h.service.sessionEvents(h.db, session.id).filter((event) => event.type === 'turn.started')
  ).toHaveLength(1)
})

it('recovers the pending prompt when an older turn announces itself again', async () => {
  const h = await boot()
  const session = h.create()
  history(h.db, session.id, [
    { type: 'user.text', turnId: 'first', text: 'first' },
    { type: 'turn.started', turnId: 'old', at: 1 },
    { type: 'turn.done', turnId: 'old', stopReason: 'end' },
    { type: 'user.text', turnId: 'second', text: 'second' },
    { type: 'turn.started', turnId: 'old', at: 2 }
  ])
  expect(h.service.closeInterruptedTurns(h.db)).toBe(1)
  expect(h.service.sessionEvents(h.db, session.id).at(-1)).toMatchObject({
    type: 'turn.done',
    turnId: 'second',
    stopReason: 'interrupted'
  })
  expect(h.service.closeInterruptedTurns(h.db)).toBe(0)
})

it('does not send or write when delayed startup returns after its database closes', async () => {
  const h = await boot()
  const starting = gate()
  h.holdStart(starting.promise)
  const session = h.create()
  const sending = h.service.sendTurn(h.db, session.id, 'hello')
  await vi.waitFor(() => expect(h.sessions).toHaveLength(1))
  h.db.close()
  starting.resolve()
  await expect(sending).resolves.toBeUndefined()
  expect(h.sent).toEqual([])
})

it('retires a prompt waiting for setup before closing its database', async () => {
  const h = await boot()
  const session = h.create()
  h.db.prepare("UPDATE workspaces SET state = 'setting_up' WHERE id = 'w1'").run()
  const sending = h.call('sessions:send', session.id, 'waiting', 'waiting')
  await vi.waitFor(() =>
    expect(h.db.prepare('SELECT 1 FROM accepted_messages WHERE id = ?').get('waiting')).toBeDefined()
  )
  h.service.closeAllSessions(h.db)
  h.db.prepare("UPDATE workspaces SET state = 'ready' WHERE id = 'w1'").run()
  await sending
  expect(h.sent).toEqual([])
  expect(h.service.sessionEvents(h.db, session.id)).toEqual([])
  const restarted = await boot(new Database(h.db.serialize()))
  expect(restarted.service.sessionQueue(session.id).map((item) => item.text)).toEqual(['waiting'])
})

it('records cancellation when a running tab closes, without waiting for retired stream events', async () => {
  const h = await boot()
  const session = h.create()
  await h.service.sendTurn(h.db, session.id, 'hello')
  h.streams[0]!.push({ type: 'turn.started', turnId: 'active', at: 1 })
  await flush()
  h.service.closeSessionRow(h.db, session.id)
  expect(h.service.sessionEvents(h.db, session.id).at(-1)).toMatchObject({
    type: 'turn.done',
    turnId: 'active',
    stopReason: 'cancelled'
  })
  expect(h.service.closeInterruptedTurns(h.db)).toBe(0)
})

it('does not restore discarded urgent inputs when a closed tab is reopened after restart', async () => {
  const h = await boot()
  const session = h.create()
  await h.call('sessions:send', session.id, 'first', 'first')
  const acknowledged = gate()
  h.sessions[0]!.cancel = vi.fn(async () => {
    await acknowledged.promise
  })
  const sending = h.call('sessions:sendNow', session.id, 'discard this', 'urgent')
  await vi.waitFor(() => expect(h.sessions[0]!.cancel).toHaveBeenCalledOnce())
  h.service.closeSessionRow(h.db, session.id)
  acknowledged.resolve()
  await sending
  const restarted = await boot(new Database(h.db.serialize()))
  restarted.service.reopenSession(restarted.db, session.id)
  expect(restarted.service.sessionQueue(session.id)).toEqual([])
  expect(restarted.sent).toEqual([])
})

it('recovers an accepted message interrupted before its first transcript event, without replaying it', async () => {
  const h = await boot()
  const session = h.create()
  h.db.prepare("UPDATE workspaces SET state = 'setting_up' WHERE id = 'w1'").run()
  const sending = h.call('sessions:send', session.id, 'waiting for setup', 'waiting')
  const outcome = sending.catch(() => {})
  await vi.waitFor(() =>
    expect(h.db.prepare('SELECT 1 FROM accepted_messages WHERE id = ?').get('waiting')).toBeDefined()
  )
  const restarted = await boot(new Database(h.db.serialize()))
  expect(restarted.service.sessionQueue(session.id).map((item) => item.text)).toEqual(['waiting for setup'])
  await restarted.call('sessions:send', session.id, 'waiting for setup', 'waiting')
  expect(restarted.service.sessionQueue(session.id)).toHaveLength(1)
  expect(restarted.sent).toEqual([])
  h.db.prepare("UPDATE workspaces SET state = 'error' WHERE id = 'w1'").run()
  await outcome
})

it('does not keep an acceptance marker when recording the user message fails', async () => {
  const h = await boot()
  const session = h.create()
  h.db.exec(
    "CREATE TRIGGER refuse_prompt BEFORE INSERT ON events WHEN NEW.type = 'user.text' BEGIN SELECT RAISE(ABORT, 'disk write failed'); END"
  )
  await expect(h.call('sessions:send', session.id, 'hello', 'retry')).rejects.toThrow('disk write failed')
  expect(h.db.prepare('SELECT 1 FROM accepted_messages WHERE id = ?').get('retry')).toBeUndefined()
  expect(h.service.sessionEvents(h.db, session.id)).toEqual([])
  h.db.exec('DROP TRIGGER refuse_prompt')
  await h.call('sessions:send', session.id, 'hello', 'retry')
  await h.call('sessions:send', session.id, 'hello', 'retry')
  expect(h.sent).toEqual(['hello'])
})

it('does not leave a refused queued message in memory or durable storage', async () => {
  const h = await boot()
  const session = h.create()
  await h.call('sessions:send', session.id, 'first', 'first')
  h.db.exec(
    "CREATE TRIGGER refuse_queue BEFORE INSERT ON queued_messages BEGIN SELECT RAISE(ABORT, 'queue write failed'); END"
  )
  await expect(h.call('sessions:send', session.id, 'queued', 'queued')).rejects.toThrow('queue write failed')
  expect(h.service.sessionQueue(session.id)).toEqual([])
  expect(h.db.prepare('SELECT 1 FROM accepted_messages WHERE id = ?').get('queued')).toBeUndefined()
  expect(h.db.prepare('SELECT * FROM queued_messages').all()).toEqual([])
  h.db.exec('DROP TRIGGER refuse_queue')
  await h.call('sessions:send', session.id, 'queued', 'queued')
  expect(h.service.sessionQueue(session.id).map((item) => item.text)).toEqual(['queued'])
})

it('keeps a queued message across a crash during its handoff to the next turn', async () => {
  const h = await boot()
  const session = h.create()
  await h.call('sessions:send', session.id, 'first', 'first')
  h.streams[0]!.push({ type: 'turn.started', turnId: 'old', at: 1 })
  await flush()
  await h.call('sessions:send', session.id, 'second', 'second')
  await h.call('sessions:send', session.id, 'third', 'third')
  let snapshot: Buffer | undefined
  h.service.setQueueSink(() => {
    snapshot ??= h.db.serialize()
  })
  h.streams[0]!.push({ type: 'turn.done', turnId: 'old', stopReason: 'end' })
  await vi.waitFor(() => expect(snapshot).toBeDefined())
  const restarted = await boot(new Database(snapshot!))
  expect(restarted.service.sessionQueue(session.id).map((item) => item.text)).toEqual(['second', 'third'])
  expect(restarted.sent).toEqual([])
})

it('keeps a queued input visible when saving its handoff fails', async () => {
  const h = await boot()
  const session = h.create()
  await h.call('sessions:send', session.id, 'first', 'first')
  h.streams[0]!.push({ type: 'turn.started', turnId: 'active', at: 1 })
  await flush()
  await h.call('sessions:send', session.id, 'second', 'second')
  h.db.exec(
    "CREATE TRIGGER refuse_handoff BEFORE DELETE ON queued_messages BEGIN SELECT RAISE(ABORT, 'handoff write failed'); END"
  )
  h.streams[0]!.push({ type: 'turn.done', turnId: 'active', stopReason: 'end' })
  await flush()
  expect(h.service.sessionQueue(session.id).map((item) => item.text)).toEqual(['second'])
  expect(h.sent).toEqual(['first'])
  h.db.exec('DROP TRIGGER refuse_handoff')
  const restarted = await boot(new Database(h.db.serialize()))
  expect(restarted.service.sessionQueue(session.id).map((item) => item.text)).toEqual(['second'])
})

it.each(['sessions:sendNow', 'sessions:steer'])(
  'keeps an accepted %s waiting after a crash during provider acknowledgement',
  async (channel) => {
    const h = await boot()
    const session = h.create()
    await h.call('sessions:send', session.id, 'first', 'first')
    h.streams[0]!.push({ type: 'turn.started', turnId: 'active', at: 1 })
    await flush()
    const acknowledged = gate()
    const receive = vi.fn(async () => {
      await acknowledged.promise
    })
    if (channel === 'sessions:sendNow') h.sessions[0]!.cancel = receive
    else h.sessions[0]!.steer = receive
    const sending = h.call(channel, session.id, 'keep this', 'pending')
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce())
    const restarted = await boot(new Database(h.db.serialize()))
    expect(restarted.service.sessionQueue(session.id).map((item) => item.text)).toEqual(['keep this'])
    expect(restarted.sent).toEqual([])
    acknowledged.resolve()
    await sending
  }
)

it('matches guidance receipts by identity when two inputs have the same text', async () => {
  const h = await boot()
  const session = h.create()
  await h.call('sessions:send', session.id, 'first', 'first')
  h.streams[0]!.push({ type: 'turn.started', turnId: 'active', at: 1 })
  await flush()
  h.sessions[0]!.steer = async () => {}
  await h.call('sessions:steer', session.id, 'same guidance', 'guidance-1')
  await h.call('sessions:steer', session.id, 'same guidance', 'guidance-2')
  h.streams[0]!.push({
    type: 'user.steer',
    turnId: 'active',
    text: 'same guidance',
    messageId: 'guidance-1'
  } as AgentEvent)
  await flush()
  const restarted = await boot(new Database(h.db.serialize()))
  expect(restarted.service.sessionQueue(session.id).map((item) => item.text)).toEqual(['same guidance'])
  await restarted.call('sessions:steer', session.id, 'same guidance', 'guidance-2')
  expect(restarted.service.sessionQueue(session.id)).toHaveLength(1)
  expect(restarted.sent).toEqual([])
})
