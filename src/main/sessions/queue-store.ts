import type Database from 'better-sqlite3'
import type { QueuedTurn, QueueStore } from './service'

/**
 * Keeps each tab's waiting messages in the database, so they outlive the process that
 * accepted them. Queues are a handful of rows; a save rewrites the tab's whole queue.
 */
export function sqliteQueueStore(db: Database.Database): QueueStore {
  const clear = db.prepare('DELETE FROM queued_messages WHERE session_id = ?')
  const insert = db.prepare(
    'INSERT INTO queued_messages (id, session_id, position, payload) VALUES (?, ?, ?, ?)'
  )
  const save = db.transaction((sessionId: string, items: readonly QueuedTurn[]) => {
    clear.run(sessionId)
    items.forEach((item, position) => insert.run(item.id, sessionId, position, JSON.stringify(item)))
  })
  return {
    save,
    load() {
      const rows = db
        .prepare('SELECT session_id, payload FROM queued_messages ORDER BY session_id, position')
        .all() as Array<{ session_id: string; payload: string }>
      const queues = new Map<string, QueuedTurn[]>()
      for (const row of rows) {
        const queue = queues.get(row.session_id) ?? []
        queue.push(JSON.parse(row.payload) as QueuedTurn)
        queues.set(row.session_id, queue)
      }
      return queues
    }
  }
}
