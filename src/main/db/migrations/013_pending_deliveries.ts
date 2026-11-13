import type { Migration } from './index'

export const m013: Migration = {
  name: '013_pending_deliveries',
  up(db) {
    db.exec(`
      CREATE TABLE pending_deliveries (
        id TEXT PRIMARY KEY REFERENCES accepted_messages(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('send', 'sendNow', 'steer')),
        payload TEXT NOT NULL
      );
      CREATE INDEX idx_pending_deliveries_session ON pending_deliveries(session_id);
    `)
  }
}
