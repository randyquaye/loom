import { create } from 'zustand'
import type {
  NumberedSessionEventPush,
  SessionActivity,
  SessionForkInput,
  SessionRow,
  SessionUnread,
  SequencedEvent
} from '../../shared/ipc-contract'
import type { AgentEvent } from '../../shared/events'
import { openTurn } from '../../shared/turn-state'
import type { BackendId, Effort, ModelDescriptor } from '../../shared/models'
import { createCompletionChime } from '../audio/completion'

interface SessionsState {
  activity: SessionActivity
  unreadBySession: Record<string, SessionUnread>
  loadUnread(): Promise<void>
  markRead(sessionId: string): Promise<void>
  sessionsByWorkspace: Record<string, SessionRow[]>
  eventsBySession: Record<string, AgentEvent[]>
  activeSessionByWorkspace: Record<string, string | null>
  modelsByBackend: Record<string, ModelDescriptor[]>
  /** Last catalog failure per backend; cleared when a retry starts. */
  modelErrorByBackend: Record<string, string>
  load(workspaceId: string): Promise<void>
  /** After the runner connection returns: refresh open workspaces' tabs and fetch what they missed. */
  catchUp(): Promise<void>
  loadModels(backend: BackendId): Promise<void>
  /** Clear a failed catalog load and fetch it again. */
  retryModels(backend: BackendId): Promise<void>
  create(workspaceId: string, backend: BackendId, model: string, effort: Effort): Promise<SessionRow>
  send(sessionId: string, text: string): Promise<void>
  /** Interrupt the turn in flight and send this message ahead of the queue. */
  cancel(sessionId: string): Promise<void>
  /**
   * Close a session tab (the worktree is untouched). If it was active, the next remaining
   * session (else the previous, else compose mode) becomes active.
   */
  close(workspaceId: string, sessionId: string): Promise<void>
  /** Fork into a new session with another model/effort and make it active right away. */
  fork(input: SessionForkInput): Promise<SessionRow>
  /** Bring a recently closed tab back (transcript and worktree were never deleted). */
  reopen(workspaceId: string, sessionId: string): Promise<void>
  setActive(workspaceId: string, sessionId: string): void
}

/** Per tab: the number of the last event shown, and whether its history has been fetched. */
const lastSeq = new Map<string, number>()
const loaded = new Set<string>()
const loading = new Map<string, Promise<void>>()
/** Events beyond a gap stay here, including when a history request fails. */
const waiting = new Map<string, Map<number, SequencedEvent>>()

function heldEvents(sessionId: string): Map<number, SequencedEvent> {
  let held = waiting.get(sessionId)
  if (held === undefined) {
    held = new Map()
    waiting.set(sessionId, held)
  }
  return held
}

function setEvents(sessionId: string, next: (current: AgentEvent[]) => AgentEvent[]): void {
  useSessions.setState((s) => ({
    eventsBySession: { ...s.eventsBySession, [sessionId]: next(s.eventsBySession[sessionId] ?? []) }
  }))
}

/** Appends a live event unless its number says it is already shown; reports whether it was new. */
function showLive(sessionId: string, event: AgentEvent, seq: number | undefined): boolean {
  if (seq !== undefined) {
    if (seq <= (lastSeq.get(sessionId) ?? 0)) return false
    lastSeq.set(sessionId, seq)
  }
  setEvents(sessionId, (current) => [...current, event])
  return true
}

/**
 * Fetches a tab's events numbered above `after`. Live events can arrive while the answer is
 * on its way: a turn runs in a tab before it is opened, or carries on across a reconnect.
 * Those are held back and joined on by number, so the transcript is complete, in order,
 * with no repeats.
 */
function fetchEvents(sessionId: string, after: number): Promise<void> {
  const inFlight = loading.get(sessionId)
  if (inFlight !== undefined) return inFlight
  const held = heldEvents(sessionId)
  let advanced = false
  const done = window.loom.sessions
    .eventsAfter(sessionId, after)
    .then((fetched) => {
      for (const entry of fetched) held.set(entry.seq, entry)
      let last = after
      const fresh: AgentEvent[] = []
      while (held.has(last + 1)) {
        last += 1
        fresh.push(held.get(last)!.event)
        held.delete(last)
      }
      for (const seq of held.keys()) if (seq <= last) held.delete(seq)
      advanced = last > after
      lastSeq.set(sessionId, last)
      loaded.add(sessionId)
      // From zero the answer is the whole history: it replaces whatever arrived before it.
      setEvents(sessionId, (current) => (after === 0 ? fresh : [...current, ...fresh]))
    })
    .finally(() => {
      loading.delete(sessionId)
      if (advanced && held.size > 0) {
        void fetchEvents(sessionId, lastSeq.get(sessionId) ?? 0).catch(() => {})
      }
    })
  loading.set(sessionId, done)
  return done
}

/** A tab's whole history is fetched once. */
function loadHistory(sessionId: string): Promise<void> {
  return loaded.has(sessionId) ? Promise.resolve() : fetchEvents(sessionId, 0)
}

export const useSessions = create<SessionsState>((set, get) => ({
  activity: { revision: -1, bySession: {} },
  unreadBySession: {},
  async loadUnread() {
    const unread = await window.loom.sessions.unread()
    // Live replies and read/close tombstones win over an older startup snapshot.
    set((s) => ({ unreadBySession: { ...unread, ...s.unreadBySession } }))
  },
  async markRead(sessionId) {
    const unread = get().unreadBySession[sessionId]
    if (!unread?.seq) return
    await window.loom.sessions.markRead(sessionId, unread.seq)
    set((s) =>
      s.unreadBySession[sessionId]?.seq === unread.seq
        ? { unreadBySession: { ...s.unreadBySession, [sessionId]: { ...unread, seq: 0 } } }
        : s
    )
  },
  sessionsByWorkspace: {},
  eventsBySession: {},
  activeSessionByWorkspace: {},
  modelsByBackend: {},
  modelErrorByBackend: {},

  async load(workspaceId) {
    const sessions = await window.loom.sessions.list(workspaceId)
    for (const session of sessions) await loadHistory(session.id)
    set({
      sessionsByWorkspace: { ...get().sessionsByWorkspace, [workspaceId]: sessions },
      activeSessionByWorkspace: {
        ...get().activeSessionByWorkspace,
        [workspaceId]: get().activeSessionByWorkspace[workspaceId] ?? sessions[0]?.id ?? null
      }
    })
  },

  async catchUp() {
    // A tab or workspace the runner cannot answer for right now is tried again next time.
    for (const workspaceId of Object.keys(get().sessionsByWorkspace)) {
      await get()
        .load(workspaceId)
        .catch(() => {})
    }
    await Promise.all(
      [...loaded].map((sessionId) => fetchEvents(sessionId, lastSeq.get(sessionId) ?? 0).catch(() => {}))
    )
  },

  async loadModels(backend) {
    if (get().modelsByBackend[backend] !== undefined) return
    // A recorded failure sticks until retryModels, so mounts do not hammer a broken provider.
    if (get().modelErrorByBackend[backend] !== undefined) return
    try {
      const models = await window.loom.providers.models(backend)
      set({ modelsByBackend: { ...get().modelsByBackend, [backend]: models } })
    } catch (err) {
      set({ modelErrorByBackend: { ...get().modelErrorByBackend, [backend]: String(err) } })
    }
  },

  async retryModels(backend) {
    const modelErrorByBackend = { ...get().modelErrorByBackend }
    delete modelErrorByBackend[backend]
    set({ modelErrorByBackend })
    await get().loadModels(backend)
  },

  async create(workspaceId, backend, model, effort) {
    const session = await window.loom.sessions.create({
      workspaceId,
      backend,
      model,
      effort,
      title: 'New conversation'
    })
    set({
      sessionsByWorkspace: {
        ...get().sessionsByWorkspace,
        [workspaceId]: [...(get().sessionsByWorkspace[workspaceId] ?? []), session]
      },
      eventsBySession: { ...get().eventsBySession, [session.id]: [] },
      activeSessionByWorkspace: { ...get().activeSessionByWorkspace, [workspaceId]: session.id }
    })
    // A tab that was just made has no history to fetch.
    loaded.add(session.id)
    return session
  },

  async send(sessionId, text) {
    await window.loom.sessions.send(sessionId, text)
  },

  async cancel(sessionId) {
    await window.loom.sessions.cancel(sessionId)
  },

  async close(workspaceId, sessionId) {
    await window.loom.sessions.close(sessionId)
    const list = get().sessionsByWorkspace[workspaceId] ?? []
    const index = list.findIndex((s) => s.id === sessionId)
    const remaining = list.filter((s) => s.id !== sessionId)
    const wasActive = get().activeSessionByWorkspace[workspaceId] === sessionId
    // '' is the compose sentinel: no sessions left means the composer starts a fresh one.
    const nextActive = (remaining[index] ?? remaining[index - 1])?.id ?? ''
    const eventsBySession = { ...get().eventsBySession }
    delete eventsBySession[sessionId]
    loaded.delete(sessionId)
    lastSeq.delete(sessionId)
    set({
      sessionsByWorkspace: { ...get().sessionsByWorkspace, [workspaceId]: remaining },
      unreadBySession: { ...get().unreadBySession, [sessionId]: { workspaceId, seq: 0, eventId: 0 } },
      eventsBySession,
      activeSessionByWorkspace: wasActive
        ? { ...get().activeSessionByWorkspace, [workspaceId]: nextActive }
        : get().activeSessionByWorkspace
    })
  },

  async fork(input) {
    const row = await window.loom.sessions.fork(input)
    set({
      sessionsByWorkspace: {
        ...get().sessionsByWorkspace,
        [input.workspaceId]: [...(get().sessionsByWorkspace[input.workspaceId] ?? []), row]
      },
      activeSessionByWorkspace: { ...get().activeSessionByWorkspace, [input.workspaceId]: row.id }
    })
    // History arrives after the tab is already showing; live events that beat it are kept.
    void loadHistory(row.id).catch(() => {
      if (get().eventsBySession[row.id] === undefined) {
        set({ eventsBySession: { ...get().eventsBySession, [row.id]: [] } })
      }
    })
    return row
  },

  async reopen(workspaceId, sessionId) {
    await window.loom.sessions.reopen(sessionId)
    const unreadBySession = { ...get().unreadBySession }
    delete unreadBySession[sessionId]
    set({ unreadBySession })
    await get().loadUnread()
    await get().load(workspaceId)
    get().setActive(workspaceId, sessionId)
  },

  setActive(workspaceId, sessionId) {
    set({ activeSessionByWorkspace: { ...get().activeSessionByWorkspace, [workspaceId]: sessionId } })
  }
}))

/** A late completion from an older connection cannot end the newest prompt/turn. */
export function isTurnRunning(events: AgentEvent[]): boolean {
  return openTurn(events) !== undefined
}

let subscribed = false
export function subscribeSessionEvents(shouldPlayCompletionSound?: (sessionId: string) => boolean): void {
  if (subscribed) return
  subscribed = true
  const completionChime = createCompletionChime(undefined, shouldPlayCompletionSound)
  const applyActivity = (activity: SessionActivity) => {
    useSessions.setState((s) => (activity.revision > s.activity.revision ? { activity } : s))
  }
  window.loom.onSessionActivity(applyActivity)
  void window.loom.sessions
    .activity()
    .then(applyActivity)
    .catch((error: unknown) => {
      console.error('Could not load session activity', error)
    })
  window.loom.onSessionEvent((push) => {
    const { sessionId, event, unread } = push
    // Main numbers every event it pushes; the window type leaves the number out.
    const seq = (push as Partial<NumberedSessionEventPush>).seq
    const last = lastSeq.get(sessionId) ?? 0
    if (seq !== undefined && seq <= last) return
    if (
      seq !== undefined &&
      (loading.has(sessionId) ||
        (loaded.has(sessionId) && (seq > last + 1 || (waiting.get(sessionId)?.size ?? 0) > 0)))
    ) {
      const held = heldEvents(sessionId)
      if (held.has(seq)) return
      held.set(seq, { seq, event })
      void fetchEvents(sessionId, last).catch(() => {})
    }
    // A repeat was already shown, counted as unread and chimed for.
    else if (!showLive(sessionId, event, seq)) return
    if (unread !== undefined) {
      useSessions.setState((s) => ({ unreadBySession: { ...s.unreadBySession, [sessionId]: unread } }))
    }
    completionChime(push)
  })
  // Titles arrive after the first prompt: an excerpt first, then the model's own name.
  window.loom.onSessionTitle(({ sessionId, title }) => {
    useSessions.setState((s) => ({
      sessionsByWorkspace: Object.fromEntries(
        Object.entries(s.sessionsByWorkspace).map(([workspaceId, list]) => [
          workspaceId,
          list.map((row) => (row.id === sessionId ? { ...row, title } : row))
        ])
      )
    }))
  })
}
