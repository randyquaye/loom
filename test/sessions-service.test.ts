import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { getBackend, registerBackend } from '../src/main/agents/registry'
import type { AgentBackend, RunningSession } from '../src/main/agents/types'
import { createEventQueue } from '../src/main/agents/queue'
import { setEnvSecretStore } from '../src/main/env/vars'
import { writeInstructions } from '../src/main/instructions/files'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import {
  answerQuestion,
  steerTurn,
  cancelTurn,
  closedSessions,
  closeSessionRow,
  createSession,
  dequeue,
  listSessions,
  reopenSession,
  sendNow,
  sendTurn,
  SessionLimitError,
  sessionEvents,
  sessionActivity,
  sessionQueue,
  setLoomDataRoot,
  setSessionSink,
  setTitleSink
} from '../src/main/sessions/service'
import type { AgentEvent } from '../src/shared/events'
import type { SessionEventPush } from '../src/shared/ipc-contract'
import type { BackendId, SessionOpts } from '../src/shared/models'

// workspaceEnv reads the env-var overlay from the secret store; tests wire a throwaway one.
beforeEach(() => {
  setEnvSecretStore(
    createSecretStore(
      path.join(mkdtempSync(path.join(tmpdir(), 'loom-env-svc-')), 'secrets.enc'),
      aesGcmCipher(randomBytes(32))
    )
  )
})

function seedWorkspace() {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
    'p1',
    'demo',
    '/tmp/demo',
    1
  )
  db.prepare(
    'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('w1', 'p1', 'ws', 'loom/ws', '/tmp/wt', 1)
  return db
}

function fakeBackend(
  scripted: AgentEvent[],
  hang = false,
  title: string | null = null,
  id: BackendId = 'qwen'
): {
  sent: string[]
  cancelled: { value: boolean }
  opts: SessionOpts[]
  sessions: RunningSession[]
} {
  const sent: string[] = []
  const cancelled = { value: false }
  const opts: SessionOpts[] = []
  const sessions: RunningSession[] = []
  const backend: AgentBackend = {
    id,
    kind: 'loop',
    authStatus: async () => ({ state: 'ready' }),
    listModels: async () => [{ id: 'qwen3-max', label: 'Qwen3 Max', efforts: ['medium'] }],
    title: async () => title,
    startSession: async (options): Promise<RunningSession> => {
      opts.push(options)
      const session: RunningSession = {
        send: async (text) => {
          sent.push(text)
        },
        cancel: async () => {
          cancelled.value = true
        },
        close: async () => {},
        events: (async function* () {
          for (const event of scripted) yield event
          if (hang) await new Promise(() => {})
        })()
      }
      sessions.push(session)
      return session
    }
  }
  registerBackend(backend)
  return { sent, cancelled, opts, sessions }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('session service', () => {
  it.each(['end', 'cancelled', 'error'] as const)(
    'keeps other sessions active after a turn ends with %s',
    async (stopReason) => {
      const db = seedWorkspace()
      const h = fakeBackend([], true)
      const backend = getBackend('qwen')!
      const start = backend.startSession.bind(backend)
      const streams = [createEventQueue(), createEventQueue()]
      backend.startSession = async (opts) => {
        const session = await start(opts)
        session.events = streams[h.sessions.length - 1]!.iterable
        return session
      }
      const rows = [1, 2].map(() =>
        createSession(db, {
          workspaceId: 'w1',
          backend: 'qwen',
          model: 'qwen3-max',
          effort: 'medium',
          title: 'activity'
        })
      )
      try {
        for (const row of rows) await sendTurn(db, row.id, 'work')
        const initial = sessionActivity()
        expect(rows.map((row) => initial.bySession[row.id])).toEqual(['w1', 'w1'])
        streams[0]!.push({ type: 'turn.done', turnId: 'first', stopReason })
        await vi.waitFor(() => expect(sessionActivity().bySession[rows[0]!.id]).toBeUndefined())
        expect(sessionActivity().bySession[rows[1]!.id]).toBe('w1')
        closeSessionRow(db, rows[1]!.id)
        expect(sessionActivity().bySession[rows[1]!.id]).toBeUndefined()
        expect(sessionActivity().revision).toBeGreaterThan(initial.revision)
      } finally {
        rows.forEach((row) => closeSessionRow(db, row.id))
        streams.forEach((stream) => stream.end())
      }
    }
  )

  it('submits late nonblocking answers as explicit follow-ups without storing secret values', async () => {
    const db = seedWorkspace()
    const script: AgentEvent[] = [
      {
        type: 'question.requested',
        requestId: 'async',
        turnId: 't',
        blocking: false,
        questions: [
          { id: 'token', header: 'Credentials', question: 'Which token?', isSecret: true, isOther: false }
        ]
      },
      { type: 'turn.done', turnId: 't', stopReason: 'end' }
    ]
    const h = fakeBackend(script)
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'answers'
    })
    try {
      await sendTurn(db, session.id, 'first')
      await new Promise((resolve) => setImmediate(resolve))
      script.length = 0
      await answerQuestion(db, session.id, {
        requestId: 'async',
        answers: { token: ['private-token-value'] }
      })
      await vi.waitFor(() => expect(h.sent).toHaveLength(2))
      expect(h.sent[1]).toContain('Which token?\nAnswer: private-token-value')
      expect(JSON.stringify(sessionEvents(db, session.id))).not.toContain('private-token-value')
      expect(sessionEvents(db, session.id)).toContainEqual(
        expect.objectContaining({
          type: 'question.answered',
          requestId: 'async',
          answers: { token: ['[hidden]'] }
        })
      )
    } finally {
      closeSessionRow(db, session.id)
    }
  })
  it.each(['close', 'cancel'])('does not revive a %s startup or replace its successor', async (action) => {
    const db = seedWorkspace()
    const h = fakeBackend([], true)
    const backend = getBackend('qwen')!
    const start = backend.startSession.bind(backend)
    let release!: () => void
    backend.startSession = async (opts) => {
      const session = await start(opts)
      if (h.sessions.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return session
    }
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'startup'
    })
    const first = sendTurn(db, session.id, 'old')
    try {
      await vi.waitFor(() => expect(h.sessions).toHaveLength(1))
      if (action === 'close') {
        closeSessionRow(db, session.id)
        reopenSession(db, session.id)
      } else await cancelTurn(db, session.id)
      await sendTurn(db, session.id, 'new')
      release()
      await first
      expect(h.sent).toEqual(['new'])
    } finally {
      release?.()
      await first
      closeSessionRow(db, session.id)
    }
  })
  it('steers the live turn without consuming queued messages or cancelling work', async () => {
    const db = seedWorkspace()
    const h = fakeBackend([], true)
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'steer'
    })
    try {
      await sendTurn(db, session.id, 'first')
      await sendTurn(db, session.id, 'queued')
      const steer = vi.fn<NonNullable<RunningSession['steer']>>().mockResolvedValue(undefined)
      h.sessions[0]!.steer = steer
      await steerTurn(db, session.id, 'guidance')
      expect(steer).toHaveBeenCalledExactlyOnceWith('guidance')
      expect(h.sent).toEqual(['first'])
      expect(h.cancelled.value).toBe(false)
      expect(sessionQueue(session.id)).toEqual(['queued'])
    } finally {
      closeSessionRow(db, session.id)
    }
    await expect(steerTurn(db, session.id, 'late')).rejects.toThrow()
  })
  it('does not let a retired connection settle a reopened turn', async () => {
    const db = seedWorkspace()
    const h = fakeBackend([], true)
    const backend = getBackend('qwen')!
    const start = backend.startSession.bind(backend)
    const streams = [createEventQueue(), createEventQueue()]
    backend.startSession = async (opts) => {
      const session = await start(opts)
      session.events = streams[h.sessions.length - 1]!.iterable
      return session
    }
    const row = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'reopened'
    })
    try {
      await sendTurn(db, row.id, 'old')
      streams[0]!.push({ type: 'turn.started', turnId: 'old', at: 1 })
      closeSessionRow(db, row.id)
      reopenSession(db, row.id)
      await sendTurn(db, row.id, 'new')
      streams[1]!.push({ type: 'turn.started', turnId: 'new', at: 2 })
      streams[0]!.push({ type: 'turn.done', turnId: 'old', stopReason: 'cancelled' })
      streams[0]!.end()
      await new Promise((resolve) => setImmediate(resolve))
      await sendTurn(db, row.id, 'queued')
      expect(h.sent).toEqual(['old', 'new'])
      expect(sessionQueue(row.id)).toEqual(['queued'])
    } finally {
      streams.forEach((stream) => stream.end())
      closeSessionRow(db, row.id)
    }
  })
  it('keeps attachment preparation from letting a later plain prompt overtake the first', async () => {
    const db = seedWorkspace()
    const root = mkdtempSync(path.join(tmpdir(), 'loom-order-'))
    writeFileSync(path.join(root, 'notes.txt'), 'attached')
    db.prepare('UPDATE workspaces SET worktree_path = ? WHERE id = ?').run(root, 'w1')
    const h = fakeBackend([], true)
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'ordered'
    })
    try {
      await Promise.all([
        sendTurn(db, session.id, 'first', ['notes.txt']),
        sendTurn(db, session.id, 'second')
      ])
      expect(h.sent).toHaveLength(1)
      expect(h.sent[0]).toMatch(/first$/)
      expect(sessionQueue(session.id)).toEqual(['second'])
    } finally {
      closeSessionRow(db, session.id)
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('replaces a failed connection without discarding messages queued behind it', async () => {
    const db = seedWorkspace()
    const h = fakeBackend([], true)
    const events = createEventQueue()
    const backend = getBackend('qwen')!
    const start = backend.startSession.bind(backend)
    backend.startSession = async (opts) => {
      const session = await start(opts)
      if (h.sessions.length === 1) session.events = events.iterable
      return session
    }
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'recovery'
    })
    try {
      await sendTurn(db, session.id, 'first')
      await sendTurn(db, session.id, 'queued')
      events.push({ type: 'error', turnId: 't', code: 'connection', message: 'lost', retryable: false })
      events.push({ type: 'turn.done', turnId: 't', stopReason: 'error' })
      events.end()
      await new Promise((resolve) => setImmediate(resolve))
      expect(sessionQueue(session.id)).toEqual(['queued'])
      await sendTurn(db, session.id, 'retry')
      expect(h.sessions).toHaveLength(2)
      expect(h.sent).toEqual(['first', 'retry'])
      expect(sessionQueue(session.id)).toEqual(['queued'])
    } finally {
      closeSessionRow(db, session.id)
    }
  })

  it('answers only the selected live session without consuming its queue or recording answer text', async () => {
    const db = seedWorkspace()
    const h = fakeBackend([{ type: 'turn.started', turnId: 't', at: 1 }], true)
    const create = () =>
      createSession(db, {
        workspaceId: 'w1',
        backend: 'qwen',
        model: 'qwen3-max',
        effort: 'medium',
        title: 'question'
      })
    const first = create()
    const second = create()
    const answer = { requestId: 'request', answers: { pick: ['selected answer'] } }
    await expect(answerQuestion(db, first.id, answer)).rejects.toThrow()
    await sendTurn(db, first.id, 'first')
    await sendTurn(db, second.id, 'second')
    await sendTurn(db, first.id, 'queued')
    await expect(answerQuestion(db, first.id, answer)).rejects.toThrow()
    const reply = vi
      .fn<NonNullable<RunningSession['answerQuestion']>>()
      .mockRejectedValueOnce(new Error('reply failed'))
      .mockResolvedValue(undefined)
    h.sessions[0]!.answerQuestion = reply
    const otherReply = vi.fn<NonNullable<RunningSession['answerQuestion']>>().mockResolvedValue(undefined)
    h.sessions[1]!.answerQuestion = otherReply
    const before = sessionEvents(db, first.id)
    try {
      await answerQuestion(db, second.id, answer)
      expect(otherReply).toHaveBeenCalledExactlyOnceWith(answer)
      expect(reply).not.toHaveBeenCalled()
      await expect(answerQuestion(db, first.id, answer)).rejects.toThrow('reply failed')
      await answerQuestion(db, first.id, answer)
      expect(reply).toHaveBeenCalledTimes(2)
      expect(sessionQueue(first.id)).toEqual(['queued'])
      expect(h.sent).toEqual(['first', 'second'])
      expect(h.cancelled.value).toBe(false)
      expect(sessionEvents(db, first.id)).toEqual(before)
      closeSessionRow(db, first.id)
      await expect(answerQuestion(db, first.id, answer)).rejects.toThrow()
      expect(reply).toHaveBeenCalledTimes(2)
    } finally {
      closeSessionRow(db, first.id)
      closeSessionRow(db, second.id)
    }
  })

  it('creates sessions and enforces the per-workspace cap', () => {
    const db = seedWorkspace()
    for (let i = 0; i < 5; i++) {
      createSession(db, {
        workspaceId: 'w1',
        backend: 'qwen',
        model: 'qwen3-max',
        effort: 'medium',
        title: `s${i}`
      })
    }
    expect(listSessions(db, 'w1')).toHaveLength(5)
    expect(() =>
      createSession(db, {
        workspaceId: 'w1',
        backend: 'qwen',
        model: 'qwen3-max',
        effort: 'medium',
        title: 'sixth'
      })
    ).toThrow(SessionLimitError)
  })

  it('records the user turn, pumps backend events and replays them in order', async () => {
    const db = seedWorkspace()
    const pushes: SessionEventPush[] = []
    setSessionSink((push) => pushes.push(push))
    const scripted: AgentEvent[] = [
      { type: 'turn.started', turnId: 't', at: 1 },
      { type: 'text.delta', turnId: 't', text: 'answer' },
      { type: 'turn.done', turnId: 't', stopReason: 'end' }
    ]
    const { sent } = fakeBackend(scripted)
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'chat'
    })

    await sendTurn(db, session.id, 'question')
    await waitFor(() => sessionEvents(db, session.id).some((e) => e.type === 'turn.done'))

    expect(sent).toEqual(['question'])
    const replayed = sessionEvents(db, session.id)
    expect(replayed[0]).toEqual({ type: 'user.text', turnId: expect.any(String), text: 'question' })
    expect(replayed.map((e) => e.type)).toEqual(['user.text', 'turn.started', 'text.delta', 'turn.done'])
    expect(pushes.map((p) => p.event.type)).toContain('text.delta')
  })

  it('cancels through the live session', async () => {
    const db = seedWorkspace()
    const { cancelled } = fakeBackend([], true)
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'chat'
    })
    await sendTurn(db, session.id, 'hi')
    await cancelTurn(db, session.id)
    expect(cancelled.value).toBe(true)
    expect(getBackend('qwen')).toBeDefined()
    closeSessionRow(db, session.id)
  })

  it('appends the project general prompt to the session system prompt', async () => {
    const db = seedWorkspace()
    db.prepare('UPDATE projects SET custom_prompt_general = ? WHERE id = ?').run(
      'Always answer in haiku.',
      'p1'
    )
    const { opts } = fakeBackend([])
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'chat'
    })

    await sendTurn(db, session.id, 'hi')
    await waitFor(() => opts.length > 0)

    expect(opts[0]?.systemPromptAppend).toContain('Always answer in haiku.')
  })

  it('hides closed sessions, lists them newest first and reopens them', () => {
    const db = seedWorkspace()
    const a = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'a'
    })
    const b = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'b'
    })
    closeSessionRow(db, a.id)
    closeSessionRow(db, b.id)
    expect(listSessions(db, 'w1')).toHaveLength(0)
    expect(closedSessions(db, 'w1').map((row) => row.id)).toEqual([b.id, a.id])

    const reopened = reopenSession(db, b.id)
    expect(reopened.closedAt).toBeNull()
    expect(listSessions(db, 'w1').map((row) => row.id)).toEqual([b.id])
    expect(closedSessions(db, 'w1').map((row) => row.id)).toEqual([a.id])
  })

  it('refuses to reopen past the per-workspace cap', () => {
    const db = seedWorkspace()
    const closed = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'closed'
    })
    closeSessionRow(db, closed.id)
    for (let i = 0; i < 5; i++) {
      createSession(db, {
        workspaceId: 'w1',
        backend: 'qwen',
        model: 'qwen3-max',
        effort: 'medium',
        title: `open${i}`
      })
    }
    expect(() => reopenSession(db, closed.id)).toThrow(SessionLimitError)
  })
})

describe('turn queue', () => {
  it('queues sends during a turn and drains them in order', async () => {
    const db = seedWorkspace()
    const { sent } = fakeBackend([
      { type: 'turn.started', turnId: 't1', at: 1 },
      { type: 'turn.done', turnId: 't1', stopReason: 'end', at: 2 }
    ])
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'q'
    })

    await sendTurn(db, session.id, 'first')
    await sendTurn(db, session.id, 'second')

    expect(sessionQueue(session.id)).toEqual(['second'])
    await waitFor(() => sent.length === 2)
    expect(sent).toEqual(['first', 'second'])
    expect(sessionQueue(session.id)).toEqual([])
  })

  it('drops queued messages on request while a turn stays in flight', async () => {
    const db = seedWorkspace()
    fakeBackend([{ type: 'turn.started', turnId: 't1', at: 1 }], true)
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'q'
    })

    await sendTurn(db, session.id, 'first')
    await sendTurn(db, session.id, 'second')
    await sendTurn(db, session.id, 'third')

    expect(dequeue(session.id, 0)).toEqual(['third'])
    expect(dequeue(session.id, 5)).toEqual(['third'])
    expect(sessionQueue(session.id)).toEqual(['third'])
  })
})

/** A backend whose stream ends with turn.done once cancel is called, like a real interrupted turn. */
function cancellableBackend(): { sent: string[]; cancelled: { value: boolean } } {
  const sent: string[] = []
  const cancelled = { value: false }
  let endTurn: (() => void) | null = null
  const backend: AgentBackend = {
    id: 'qwen',
    kind: 'loop',
    authStatus: async () => ({ state: 'ready' }),
    listModels: async () => [{ id: 'qwen3-max', label: 'Qwen3 Max', efforts: ['medium'] }],
    startSession: async (): Promise<RunningSession> => ({
      send: async (text) => {
        sent.push(text)
      },
      cancel: async () => {
        cancelled.value = true
        endTurn?.()
      },
      close: async () => {},
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'turn.started', turnId: 't1', at: 1 }
        await new Promise<void>((resolve) => {
          endTurn = resolve
        })
        yield { type: 'turn.done', turnId: 't1', stopReason: 'cancelled', at: 2 }
      })()
    })
  }
  registerBackend(backend)
  return { sent, cancelled }
}

describe('send now', () => {
  it('preserves multiple urgent messages accepted before cancellation completes', async () => {
    const db = seedWorkspace()
    const h = fakeBackend([], true)
    const backend = getBackend('qwen')!
    const start = backend.startSession.bind(backend)
    const stream = createEventQueue()
    backend.startSession = async (opts) => {
      const session = await start(opts)
      session.events = stream.iterable
      return session
    }
    const row = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'urgent'
    })
    try {
      await sendTurn(db, row.id, 'first')
      await sendTurn(db, row.id, 'queued')
      await Promise.all([sendNow(db, row.id, 'urgent one'), sendNow(db, row.id, 'urgent two')])
      stream.push({ type: 'turn.done', turnId: 'first', stopReason: 'cancelled' })
      await waitFor(() => h.sent.length === 2)
      expect(h.sent).toEqual(['first', 'urgent one'])
      stream.push({ type: 'turn.done', turnId: 'urgent one', stopReason: 'end' })
      await waitFor(() => h.sent.length === 3)
      expect(h.sent).toEqual(['first', 'urgent one', 'urgent two'])
      expect(sessionQueue(row.id)).toEqual(['queued'])
    } finally {
      closeSessionRow(db, row.id)
      stream.end()
    }
  })
  it('is a plain send when the session is idle', async () => {
    const db = seedWorkspace()
    const { sent, cancelled } = fakeBackend([
      { type: 'turn.started', turnId: 't1', at: 1 },
      { type: 'turn.done', turnId: 't1', stopReason: 'end', at: 2 }
    ])
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'idle'
    })

    await sendNow(db, session.id, 'only')
    await waitFor(() => sent.length === 1)

    expect(sent).toEqual(['only'])
    expect(cancelled.value).toBe(false)
  })

  it('interrupts a running turn and goes ahead of the queue', async () => {
    const db = seedWorkspace()
    const { sent, cancelled } = cancellableBackend()
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'forced'
    })

    await sendTurn(db, session.id, 'first')
    await sendTurn(db, session.id, 'queued')
    expect(sessionQueue(session.id)).toEqual(['queued'])

    await sendNow(db, session.id, 'urgent')

    expect(cancelled.value).toBe(true)
    // The forced message waits for the old stream to end; it is not queued.
    expect(sessionQueue(session.id)).toEqual(['queued'])
    await waitFor(() => sent.includes('urgent'))
    expect(sent).toEqual(['first', 'urgent'])
    // The queued message is untouched behind the forced one.
    expect(sessionQueue(session.id)).toEqual(['queued'])
  })
})

describe('session titles', () => {
  const SCRIPT = [
    { type: 'turn.started', turnId: 't1', at: 1 },
    { type: 'turn.done', turnId: 't1', stopReason: 'end', at: 2 }
  ] as AgentEvent[]

  function newSession(db: ReturnType<typeof seedWorkspace>) {
    return createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'New conversation'
    })
  }

  it('names a conversation from its first prompt: excerpt now, model name when it lands', async () => {
    const db = seedWorkspace()
    const pushes: Array<{ sessionId: string; title: string }> = []
    setTitleSink((push) => pushes.push(push))
    fakeBackend(SCRIPT, false, 'Rename the queue drain')
    const session = newSession(db)

    await sendTurn(db, session.id, 'Fix the login flow for SSO providers today please')
    await waitFor(() => pushes.length >= 2)

    expect(pushes.map((p) => p.title)).toEqual(['Fix the login flow for', 'Rename the queue drain'])
    expect(pushes.every((p) => p.sessionId === session.id)).toBe(true)
    expect(listSessions(db, 'w1')[0]?.title).toBe('Rename the queue drain')
  })

  it('keeps the excerpt when the backend cannot name the session', async () => {
    const db = seedWorkspace()
    const pushes: Array<{ sessionId: string; title: string }> = []
    setTitleSink((push) => pushes.push(push))
    fakeBackend(SCRIPT, false, null)
    const session = newSession(db)

    await sendTurn(db, session.id, 'Summarize this repository for a new joiner')
    await waitFor(() => pushes.length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(pushes.map((p) => p.title)).toEqual(['Summarize this repository for a'])
  })

  it('does not rename on later prompts', async () => {
    const db = seedWorkspace()
    const pushes: Array<{ sessionId: string; title: string }> = []
    setTitleSink((push) => pushes.push(push))
    fakeBackend(SCRIPT, false, 'First name only')
    const session = newSession(db)

    await sendTurn(db, session.id, 'first prompt words here now please')
    await waitFor(() => pushes.length >= 2)
    await sendTurn(db, session.id, 'a completely different second prompt')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(pushes).toHaveLength(2)
  })
})

describe('attachments in turns', () => {
  const attachRoots: string[] = []

  afterAll(() => {
    for (const root of attachRoots) rmSync(root, { recursive: true, force: true })
  })

  const SCRIPT = [
    { type: 'turn.started', turnId: 't1', at: 1 },
    { type: 'turn.done', turnId: 't1', stopReason: 'end', at: 2 }
  ] as AgentEvent[]

  function worktreeWith(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'loom-attach-svc-'))
    attachRoots.push(dir)
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), content)
    }
    return dir
  }

  function newSession(db: ReturnType<typeof seedWorkspace>) {
    return createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'New conversation'
    })
  }

  it('inlines a workspace file above the message and sends the combined turn', async () => {
    const db = seedWorkspace()
    const dir = worktreeWith({ 'notes.txt': 'hello world\nsecond line\n' })
    db.prepare('UPDATE workspaces SET worktree_path = ? WHERE id = ?').run(dir, 'w1')
    const { sent } = fakeBackend(SCRIPT)
    const session = newSession(db)

    await sendTurn(db, session.id, 'explain this', ['notes.txt'])
    await waitFor(() => sent.length === 1)

    const body = sent[0] ?? ''
    expect(body).toContain('<attached file: notes.txt')
    expect(body).toContain('hello world')
    expect(body.endsWith('explain this')).toBe(true)
    const userText = sessionEvents(db, session.id).find((event) => event.type === 'user.text')
    expect(JSON.stringify(userText)).toContain('hello world')
  })

  it('refuses credential-shaped names before anything is sent', async () => {
    const db = seedWorkspace()
    const dir = worktreeWith({ '.env': 'SECRET=1\n' })
    db.prepare('UPDATE workspaces SET worktree_path = ? WHERE id = ?').run(dir, 'w1')
    const { sent } = fakeBackend(SCRIPT)
    const session = newSession(db)

    await expect(sendTurn(db, session.id, 'read this', ['.env'])).rejects.toThrow(/ATTACHMENT_REJECTED/)
    expect(sent).toEqual([])
    expect(sessionEvents(db, session.id).some((event) => event.type === 'user.text')).toBe(false)
  })

  it('keeps attachments on a message queued behind a running turn', async () => {
    const db = seedWorkspace()
    const dir = worktreeWith({ 'notes.txt': 'queued content\n' })
    db.prepare('UPDATE workspaces SET worktree_path = ? WHERE id = ?').run(dir, 'w1')
    // A turn that never ends: started, then silence.
    fakeBackend([{ type: 'turn.started', turnId: 't1', at: 1 }], true)
    const session = newSession(db)

    await sendTurn(db, session.id, 'first')
    await sendTurn(db, session.id, 'second', ['notes.txt'])

    expect(sessionQueue(session.id)[0]).toContain('queued content')
  })
})

describe('workspace readiness gate', () => {
  const SCRIPT = [
    { type: 'turn.started', turnId: 't1', at: 1 },
    { type: 'turn.done', turnId: 't1', stopReason: 'end', at: 2 }
  ] as AgentEvent[]

  function setState(db: ReturnType<typeof seedWorkspace>, state: string) {
    db.prepare('UPDATE workspaces SET state = ? WHERE id = ?').run(state, 'w1')
  }

  function newSession(db: ReturnType<typeof seedWorkspace>, title: string) {
    return createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title
    })
  }

  it('refuses to send into a workspace whose setup failed', async () => {
    const db = seedWorkspace()
    setState(db, 'error')
    const { sent } = fakeBackend(SCRIPT)
    const session = newSession(db, 'blocked')

    await expect(sendTurn(db, session.id, 'hi')).rejects.toThrow(/WORKSPACE_NOT_READY/)
    expect(sent).toEqual([])
    expect(sessionEvents(db, session.id)).toEqual([])
  })

  it('waits for a workspace that is still setting up, then sends', async () => {
    const db = seedWorkspace()
    setState(db, 'initializing')
    const { sent } = fakeBackend(SCRIPT)
    const session = newSession(db, 'patient')

    const sending = sendTurn(db, session.id, 'hi')
    setTimeout(() => setState(db, 'ready'), 60)
    await sending

    expect(sent).toEqual(['hi'])
  })
})

describe('instruction merge into the system prompt', () => {
  const SCRIPT = [
    { type: 'turn.started', turnId: 't1', at: 1 },
    { type: 'turn.done', turnId: 't1', stopReason: 'end', at: 2 }
  ] as AgentEvent[]

  const instrRoots: string[] = []

  afterAll(() => {
    for (const root of instrRoots) rmSync(root, { recursive: true, force: true })
  })

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), prefix))
    instrRoots.push(dir)
    return dir
  }

  it('gives loop backends the bundled facts, repo instruction files and the overlay', async () => {
    const db = seedWorkspace()
    const wt = tempDir('loom-instr-wt-')
    writeFileSync(path.join(wt, 'CLAUDE.md'), 'Repo rules: be terse.\n')
    db.prepare('UPDATE workspaces SET worktree_path = ? WHERE id = ?').run(wt, 'w1')
    const root = tempDir('loom-instr-root-')
    setLoomDataRoot(root)
    await writeInstructions(root, 'instance', null, 'Instance rules.')
    const { opts } = fakeBackend(SCRIPT)
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'loop'
    })

    await sendTurn(db, session.id, 'hi')
    await waitFor(() => opts.length > 0)

    const append = opts[0]?.systemPromptAppend ?? ''
    expect(append).toContain('## Loom workspace facts')
    expect(append).toContain('# Repository instructions (CLAUDE.md)')
    expect(append).toContain('Repo rules: be terse.')
    expect(append).toContain('# Instance instructions')
    expect(append).toContain('Instance rules.')
  })

  it('keeps claude on the append channel without duplicating the bundled facts', async () => {
    const db = seedWorkspace()
    const root = tempDir('loom-instr-root-')
    setLoomDataRoot(root)
    await writeInstructions(root, 'instance', null, 'Instance rules.')
    const { opts } = fakeBackend(SCRIPT, false, null, 'claude')
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'claude',
      model: 'claude-opus-4-7',
      effort: 'medium',
      title: 'cli'
    })

    await sendTurn(db, session.id, 'hi')
    await waitFor(() => opts.length > 0)

    const append = opts[0]?.systemPromptAppend ?? ''
    expect(append).toContain('# Instance instructions')
    expect(append).not.toContain('## Loom workspace facts')
  })

  it('keeps a managed root AGENTS.md companion fresh on every send', async () => {
    const db = seedWorkspace()
    const wt = tempDir('loom-agents-wt-')
    db.prepare('UPDATE workspaces SET worktree_path = ? WHERE id = ?').run(wt, 'w1')
    const root = tempDir('loom-instr-root-')
    setLoomDataRoot(root)
    await writeInstructions(root, 'instance', null, 'Instance rules.')
    fakeBackend(SCRIPT, false, null, 'codex')
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'medium',
      title: 'codex'
    })

    await sendTurn(db, session.id, 'hi')

    const deadline = Date.now() + 2000
    let body = ''
    while (Date.now() < deadline) {
      body = await readFile(path.join(wt, 'AGENTS.md'), 'utf8').catch(() => '')
      if (body !== '') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(body.startsWith('<!-- loom:managed -->')).toBe(true)
    expect(body).toContain('## Loom workspace facts')
    expect(body).toContain('Instance rules.')
  })
})

describe('model naming reaches the workspace', () => {
  const SCRIPT = [
    { type: 'turn.started', turnId: 't1', at: 1 },
    { type: 'turn.done', turnId: 't1', stopReason: 'end', at: 2 }
  ] as AgentEvent[]

  function workspaceRow(db: ReturnType<typeof seedWorkspace>) {
    return db.prepare('SELECT name, auto_named FROM workspaces WHERE id = ?').get('w1') as {
      name: string
      auto_named: number
    }
  }

  it('renames the workspace display name once when the model title lands', async () => {
    const db = seedWorkspace()
    const pushes: Array<{ sessionId: string; title: string }> = []
    setTitleSink((push) => pushes.push(push))
    fakeBackend(SCRIPT, false, 'Queue drain fix')
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'New conversation'
    })

    await sendTurn(db, session.id, 'fix the queue drain before it drops forced messages')
    await waitFor(() => pushes.length >= 2)

    expect(workspaceRow(db)).toEqual({ name: 'Queue drain fix', auto_named: 0 })
  })

  it('never renames a workspace whose auto-name flag is cleared', async () => {
    const db = seedWorkspace()
    db.prepare('UPDATE workspaces SET auto_named = 0 WHERE id = ?').run('w1')
    fakeBackend(SCRIPT, false, 'Something else entirely')
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'New conversation'
    })

    await sendTurn(db, session.id, 'a prompt that would have named the workspace')
    await waitFor(() => sessionEvents(db, session.id).some((e) => e.type === 'turn.done'))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(workspaceRow(db)).toEqual({ name: 'ws', auto_named: 0 })
  })

  it('keeps the excerpt name and the workspace name when the title call fails', async () => {
    const db = seedWorkspace()
    const pushes: Array<{ sessionId: string; title: string }> = []
    setTitleSink((push) => pushes.push(push))
    fakeBackend(SCRIPT, false, null)
    const session = createSession(db, {
      workspaceId: 'w1',
      backend: 'qwen',
      model: 'qwen3-max',
      effort: 'medium',
      title: 'New conversation'
    })

    await sendTurn(db, session.id, 'nameless task prompt words here now')
    await waitFor(() => pushes.length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(pushes.map((p) => p.title)).toEqual(['nameless task prompt words here'])
    expect(workspaceRow(db)).toEqual({ name: 'ws', auto_named: 1 })
  })
})
