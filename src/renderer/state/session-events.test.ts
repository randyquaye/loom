import { afterEach, expect, it, vi } from 'vitest'
import type { NumberedSessionEventPush, SequencedEvent, SessionRow } from '../../shared/ipc-contract'

const TAB: SessionRow = {
  id: 's1',
  workspaceId: 'w1',
  backend: 'claude',
  model: 'sonnet',
  effort: 'high',
  title: 't',
  createdAt: 1,
  closedAt: null,
  forkedFrom: null,
  providerSessionId: null
}

/** Event number `seq` of the tab, recognisable by its text. */
function numbered(seq: number): SequencedEvent {
  return { seq, event: { type: 'text.delta', turnId: 't', text: `e${seq}` } }
}

/** A fresh window: the store, with `history` standing in for what main would return. */
async function boot(history: (sessionId: string, afterSeq: number) => Promise<SequencedEvent[]>) {
  vi.resetModules()
  let deliver!: (push: NumberedSessionEventPush) => void
  vi.stubGlobal('window', {
    loom: {
      onSessionEvent: (listener: typeof deliver) => {
        deliver = listener
      },
      onSessionTitle: vi.fn(),
      onSessionActivity: vi.fn(),
      sessions: {
        activity: async () => ({ revision: 0, bySession: {} }),
        list: async () => [TAB],
        eventsAfter: history
      }
    }
  })
  const { subscribeSessionEvents, useSessions } = await import('./sessions')
  subscribeSessionEvents(() => false)
  return {
    push: (seq: number) => deliver({ sessionId: TAB.id, ...numbered(seq) }),
    load: () => useSessions.getState().load(TAB.workspaceId),
    catchUp: () => useSessions.getState().catchUp(),
    shown: () =>
      (useSessions.getState().eventsBySession[TAB.id] ?? []).map((event) =>
        event.type === 'text.delta' ? event.text : event.type
      )
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('shows the whole history of a tab whose events started arriving before it was opened', async () => {
  // A turn running in a tab nobody has opened yet: its events arrive, its history has not.
  const tab = await boot(async () => [numbered(1), numbered(2), numbered(3)])
  tab.push(2)
  tab.push(3)

  await tab.load()

  expect(tab.shown()).toEqual(['e1', 'e2', 'e3'])
})

it('puts an event that arrives while history is loading after it, once', async () => {
  let arrive!: (history: SequencedEvent[]) => void
  const tab = await boot(() => new Promise((resolve) => (arrive = resolve)))
  const loading = tab.load()
  await vi.waitFor(() => expect(arrive).toBeDefined())
  // Event 3 is also in the history about to arrive; event 4 is not.
  tab.push(3)
  tab.push(4)

  arrive([numbered(1), numbered(2), numbered(3)])
  await loading

  expect(tab.shown()).toEqual(['e1', 'e2', 'e3', 'e4'])
})

it('drops an event whose number it has already shown', async () => {
  const tab = await boot(async () => [numbered(1)])
  await tab.load()

  tab.push(2)
  tab.push(2)

  expect(tab.shown()).toEqual(['e1', 'e2'])
})

it('fills in what a tab missed while the connection was down, in order, once', async () => {
  const asked: number[] = []
  let arrive!: (missed: SequencedEvent[]) => void
  const tab = await boot((_sessionId, afterSeq) => {
    asked.push(afterSeq)
    if (afterSeq === 0) return Promise.resolve([numbered(1), numbered(2)])
    return new Promise((resolve) => (arrive = resolve))
  })
  await tab.load()

  const catchingUp = tab.catchUp()
  await vi.waitFor(() => expect(arrive).toBeDefined())
  // The connection is back, so a new event can beat the answer about the missed ones.
  tab.push(5)
  arrive([numbered(3), numbered(4)])
  await catchingUp

  expect(tab.shown()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
  // History once, then only what came after the last event it had.
  expect(asked).toEqual([0, 2])
})
