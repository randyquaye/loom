import type Database from 'better-sqlite3'
import type { SessionUnread } from '../../shared/ipc-contract'

/** `ownerId` narrows the answer to one user's workspaces, as a runner must; omitted, all of them. */
export function unreadSessions(db: Database.Database, ownerId?: string): Record<string, SessionUnread> {
  const rows = db
    .prepare(
      `
    SELECT s.id, s.workspace_id AS workspaceId, MAX(e.seq) AS seq, MAX(e.id) AS eventId
    FROM sessions s JOIN events e ON e.session_id = s.id JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.closed_at IS NULL AND e.seq > s.last_read_seq
      AND e.type IN ('text.delta', 'text.done') AND json_extract(e.payload, '$.text') != ''
      AND (@owner IS NULL OR w.owner_id = @owner)
    GROUP BY s.id
  `
    )
    .all({ owner: ownerId ?? null }) as Array<SessionUnread & { id: string }>
  return Object.fromEntries(rows.map(({ id, ...unread }) => [id, unread]))
}

/** Acknowledging an older visible reply must never consume a newer, unseen one. */
export function markSessionRead(db: Database.Database, sessionId: string, seq: number): void {
  db.prepare(
    `
    UPDATE sessions SET last_read_seq = MAX(last_read_seq, MIN(?, COALESCE(
      (SELECT MAX(seq) FROM events WHERE session_id = sessions.id), 0
    ))) WHERE id = ?
  `
  ).run(seq, sessionId)
}
