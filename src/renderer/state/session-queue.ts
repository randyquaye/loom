import type { QueuedMessage } from '../../shared/ipc-contract'

/** Queue snapshots catch up after reconnect; newer requests and live pushes always win. */
export function watchSessionQueue(
  sessionId: string,
  changed: (items: QueuedMessage[]) => void,
  failed: (error: unknown) => void
): () => void {
  let active = true
  let revision = 0
  let latest = 0
  function refresh(): void {
    if (!active) return
    const request = ++latest
    const before = revision
    const current = () => active && request === latest && revision === before
    void window.loom.sessions.queue(sessionId).then(
      (items) => {
        if (current()) changed(items)
      },
      (error: unknown) => {
        if (current()) failed(error)
      }
    )
  }
  const stopUpdates = window.loom.onSessionQueue((push) => {
    if (!active || push.sessionId !== sessionId) return
    revision += 1
    changed(push.items)
  })
  const stopStatus = window.loom.onCloudStatus((status) => {
    if (status.state === 'connected') refresh()
  })
  refresh()
  return () => {
    active = false
    stopUpdates()
    stopStatus()
  }
}
