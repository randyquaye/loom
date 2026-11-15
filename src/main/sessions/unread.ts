import type Database from 'better-sqlite3'
import type { SessionUnread } from '../../shared/ipc-contract'

/** `ownerId` narrows the answer to one user's workspaces, as a runner must; omitted, all of them. */
export function unreadSessions(
  db: Database.Database,
  ownerId?: string,
  visibleWorkspaceIds: readonly string[] = []
): Record<string, SessionUnread> {
  const rows = db
    .prepare(
      `
    SELECT s.id, s.workspace_id AS workspaceId, MAX(e.seq) AS seq, MAX(e.id) AS eventId
    FROM sessions s JOIN events e ON e.session_id = s.id JOIN workspaces w ON w.id = s.workspace_id
    LEFT JOIN org_members owner_member ON owner_member.user_id = w.owner_id
    LEFT JOIN bot_session_reads reader ON reader.session_id = s.id AND reader.user_id = @owner
    WHERE s.closed_at IS NULL AND e.seq > CASE
      WHEN @owner IS NOT NULL AND owner_member.kind = 'bot' THEN COALESCE(reader.last_read_seq, 0)
      ELSE s.last_read_seq END
      AND e.type IN ('text.delta', 'text.done') AND json_extract(e.payload, '$.text') != ''
      AND (@owner IS NULL OR w.owner_id = @owner OR (
        w.id IN (SELECT value FROM json_each(@visible))
        AND owner_member.kind = 'bot' AND owner_member.state = 'active'
      ))
    GROUP BY s.id
  `
    )
    .all({ owner: ownerId ?? null, visible: JSON.stringify(visibleWorkspaceIds) }) as Array<
    SessionUnread & { id: string }
  >
  return Object.fromEntries(rows.map(({ id, ...unread }) => [id, unread]))
}

/** Acknowledging an older visible reply must never consume a newer, unseen one. */
export function markSessionRead(
  db: Database.Database,
  sessionId: string,
  seq: number,
  userId?: string
): void {
  if (userId !== undefined) {
    const shared = db
      .prepare(
        `
      INSERT INTO bot_session_reads(session_id, user_id, last_read_seq)
      SELECT s.id, @user, MAX(0, MIN(@seq, COALESCE((SELECT MAX(seq) FROM events WHERE session_id = s.id), 0)))
      FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
      JOIN org_members m ON m.user_id = w.owner_id
      WHERE s.id = @session AND m.kind = 'bot'
      ON CONFLICT(session_id, user_id) DO UPDATE
      SET last_read_seq = MAX(bot_session_reads.last_read_seq, excluded.last_read_seq)
    `
      )
      .run({ user: userId, seq, session: sessionId })
    if (shared.changes > 0) return
  }
  db.prepare(
    `
    UPDATE sessions SET last_read_seq = MAX(last_read_seq, MIN(?, COALESCE(
      (SELECT MAX(seq) FROM events WHERE session_id = sessions.id), 0
    ))) WHERE id = ?
  `
  ).run(seq, sessionId)
}
