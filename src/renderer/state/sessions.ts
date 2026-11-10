import { create } from 'zustand'
import type { SessionActivity, SessionForkInput, SessionRow } from '../../shared/ipc-contract'
import type { AgentEvent } from '../../shared/events'
import type { BackendId, Effort, ModelDescriptor } from '../../shared/models'
import { createCompletionChime } from '../audio/completion'

interface SessionsState {
  activity: SessionActivity
  sessionsByWorkspace: Record<string, SessionRow[]>
  eventsBySession: Record<string, AgentEvent[]>
  activeSessionByWorkspace: Record<string, string | null>
  modelsByBackend: Record<string, ModelDescriptor[]>
  /** Last catalog failure per backend; cleared when a retry starts. */
  modelErrorByBackend: Record<string, string>
  load(workspaceId: string): Promise<void>
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

export const useSessions = create<SessionsState>((set, get) => ({
  activity: { revision: -1, bySession: {} },
  sessionsByWorkspace: {},
  eventsBySession: {},
  activeSessionByWorkspace: {},
  modelsByBackend: {},
  modelErrorByBackend: {},

  async load(workspaceId) {
    const sessions = await window.loom.sessions.list(workspaceId)
    const eventsBySession = { ...get().eventsBySession }
    for (const session of sessions) {
      if (eventsBySession[session.id] === undefined) {
        eventsBySession[session.id] = await window.loom.sessions.events(session.id)
      }
    }
    set({
      sessionsByWorkspace: { ...get().sessionsByWorkspace, [workspaceId]: sessions },
      eventsBySession,
      activeSessionByWorkspace: {
        ...get().activeSessionByWorkspace,
        [workspaceId]: get().activeSessionByWorkspace[workspaceId] ?? sessions[0]?.id ?? null
      }
    })
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
    set({
      sessionsByWorkspace: { ...get().sessionsByWorkspace, [workspaceId]: remaining },
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
    void window.loom.sessions
      .events(row.id)
      .then((events) => {
        if (get().eventsBySession[row.id] !== undefined) return
        set({ eventsBySession: { ...get().eventsBySession, [row.id]: events } })
      })
      .catch(() => {
        if (get().eventsBySession[row.id] === undefined) {
          set({ eventsBySession: { ...get().eventsBySession, [row.id]: [] } })
        }
      })
    return row
  },

  async reopen(workspaceId, sessionId) {
    await window.loom.sessions.reopen(sessionId)
    await get().load(workspaceId)
    get().setActive(workspaceId, sessionId)
  },

  setActive(workspaceId, sessionId) {
    set({ activeSessionByWorkspace: { ...get().activeSessionByWorkspace, [workspaceId]: sessionId } })
  }
}))

/** A late completion from an older connection cannot end the newest prompt/turn. */
export function isTurnRunning(events: AgentEvent[]): boolean {
  const done = new Set<string>()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'turn.done') done.add(event.turnId)
    if (event?.type === 'user.text' || event?.type === 'turn.started') return !done.has(event.turnId)
  }
  return false
}

let subscribed = false
export function subscribeSessionEvents(): void {
  if (subscribed) return
  subscribed = true
  const completionChime = createCompletionChime()
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
    const { sessionId, event } = push
    useSessions.setState((s) => ({
      eventsBySession: {
        ...s.eventsBySession,
        [sessionId]: [...(s.eventsBySession[sessionId] ?? []), event]
      }
    }))
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
