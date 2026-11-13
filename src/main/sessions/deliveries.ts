import type Database from 'better-sqlite3'
import type { PreparedTurn, QueuedTurn, QueueStore } from './service'

/** Acceptance always keeps the prepared input until its transcript or queue owns it. */
export function beginDelivery(
  db: Database.Database,
  sessionId: string,
  input: PreparedTurn,
  kind: 'send' | 'sendNow' | 'steer'
): void {
  if (input.messageId === undefined) return
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO accepted_messages (id, accepted_at) VALUES (?, ?)').run(
      input.messageId,
      Date.now()
    )
    db.prepare(
      'INSERT OR IGNORE INTO pending_deliveries (id, session_id, kind, payload) VALUES (?, ?, ?, ?)'
    ).run(input.messageId, sessionId, kind, JSON.stringify(input))
  })()
}

/** Called inside the transaction that records the input or saves its queue entry. */
export function finishDelivery(db: Database.Database, messageId: string | undefined): void {
  if (messageId !== undefined) db.prepare('DELETE FROM pending_deliveries WHERE id = ?').run(messageId)
}

/** An input already recorded elsewhere must keep its identity even if later work fails. */
export function rejectDelivery(db: Database.Database, messageId: string): boolean {
  return (
    db
      .prepare(
        `DELETE FROM accepted_messages WHERE id = ?
    AND EXISTS (SELECT 1 FROM pending_deliveries WHERE id = ?)`
      )
      .run(messageId, messageId).changes > 0
  )
}

/** A restart never delivers these automatically: they become visible, waiting queue entries. */
export function restorePendingDeliveries(
  db: Database.Database,
  store: Pick<QueueStore, 'save'>,
  sessionIds?: ReadonlySet<string>
): void {
  db.transaction(() => {
    const rows = db
      .prepare('SELECT id, session_id, kind, payload FROM pending_deliveries ORDER BY rowid')
      .all() as Array<{ id: string; session_id: string; kind: string; payload: string }>
    const bySession = new Map<string, typeof rows>()
    for (const row of rows) {
      if (sessionIds !== undefined && !sessionIds.has(row.session_id)) continue
      const pending = bySession.get(row.session_id) ?? []
      pending.push(row)
      bySession.set(row.session_id, pending)
    }
    for (const [sessionId, pending] of bySession) {
      const saved = db
        .prepare('SELECT payload FROM queued_messages WHERE session_id = ? ORDER BY position')
        .all(sessionId) as Array<{ payload: string }>
      const queued = saved.map(({ payload }) => JSON.parse(payload) as QueuedTurn)
      const known = new Set(queued.map((input) => input.id))
      const urgent: QueuedTurn[] = []
      const handedOff: QueuedTurn[] = []
      for (const row of pending) {
        if (known.has(row.id)) continue
        const prepared = JSON.parse(row.payload) as PreparedTurn & { id?: string }
        const input = { ...prepared, id: row.id }
        if (row.kind === 'sendNow') urgent.push(input)
        // A handoff keeps the queue item's ID; it still precedes the remaining queue.
        else if (prepared.id === row.id) handedOff.push(input)
        else queued.push(input)
        known.add(row.id)
      }
      store.save(sessionId, [...urgent, ...handedOff, ...queued])
      for (const row of pending) db.prepare('DELETE FROM pending_deliveries WHERE id = ?').run(row.id)
    }
  })()
}
