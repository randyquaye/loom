import type { Migration } from './index'

export const m010: Migration = {
  name: '010_session_durability',
  up(db) {
    db.exec(`
      CREATE TABLE queued_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX idx_queued_messages_session ON queued_messages(session_id, position);

      CREATE TABLE accepted_messages (
        id TEXT PRIMARY KEY,
        accepted_at INTEGER NOT NULL
      );
    `)
  }
}
