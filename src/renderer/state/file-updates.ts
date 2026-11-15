import { useFiles } from './files'
import { useSessions } from './sessions'

const REFRESH_DELAY_MS = 100
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'bash', 'apply_patch', 'exec_command', 'write_stdin'])

/** Refresh loaded workspaces after observed writes, including work in background sessions. */
export function subscribeFileUpdates(): () => void {
  const calls = new Map<string, Set<string>>()
  const pending = new Map<
    string,
    { timer?: ReturnType<typeof setTimeout>; running: boolean; dirty: boolean }
  >()

  function schedule(workspaceId: string): void {
    // Unopened and revoked workspaces have no file data to keep current.
    const files = useFiles.getState()
    if (files.treeByWorkspace[workspaceId] === undefined) return
    let state = pending.get(workspaceId)
    if (state === undefined) {
      state = { running: false, dirty: false }
      pending.set(workspaceId, state)
    }
    state.dirty = true
    if (state.running || state.timer !== undefined) return
    const refresh = state
    refresh.timer = setTimeout(() => {
      delete refresh.timer
      if (useFiles.getState().treeByWorkspace[workspaceId] === undefined) {
        pending.delete(workspaceId)
        return
      }
      refresh.running = true
      refresh.dirty = false
      void useFiles
        .getState()
        .refresh(workspaceId)
        .catch((error: unknown) => console.error('Could not refresh workspace files', error))
        .finally(() => {
          refresh.running = false
          if (pending.get(workspaceId) !== refresh) return
          if (refresh.dirty) schedule(workspaceId)
          else pending.delete(workspaceId)
        })
    }, REFRESH_DELAY_MS)
  }

  const unsubscribe = window.loom.onSessionEvent((push) => {
    const workspaceId =
      push.workspaceId ??
      push.unread?.workspaceId ??
      Object.entries(useSessions.getState().sessionsByWorkspace).find(([, sessions]) =>
        sessions.some((session) => session.id === push.sessionId)
      )?.[0]
    if (workspaceId === undefined) return
    const { event, sessionId } = push
    if (event.type === 'tool.call' && WRITE_TOOLS.has(event.name)) {
      const writing = calls.get(sessionId) ?? new Set<string>()
      writing.add(event.callId)
      calls.set(sessionId, writing)
    } else if (event.type === 'tool.result') {
      const writing = calls.get(sessionId)?.delete(event.callId) === true
      // A failed shell command can still have written files before failing.
      if (writing || (event.patches?.length ?? 0) > 0) schedule(workspaceId)
      if (calls.get(sessionId)?.size === 0) calls.delete(sessionId)
    } else if (event.type === 'turn.done' || event.type === 'subagent.end') {
      if (event.type === 'turn.done') calls.delete(sessionId)
      schedule(workspaceId)
    }
  })

  return () => {
    unsubscribe()
    for (const state of pending.values()) if (state.timer !== undefined) clearTimeout(state.timer)
    pending.clear()
    calls.clear()
  }
}
