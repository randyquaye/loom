import type { Migration } from './index'

export const m008: Migration = {
  name: '008_session_read',
  up(db) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN last_read_seq INTEGER NOT NULL DEFAULT 0;
      UPDATE sessions SET last_read_seq = COALESCE(
        (SELECT MAX(seq) FROM events WHERE session_id = sessions.id), 0
      );
    `)
  }
}
