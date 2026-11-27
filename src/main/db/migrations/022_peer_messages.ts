import type { Migration } from './index'

export const m022: Migration = {
  name: '022_peer_messages',
  up(db) {
    db.exec(`
      CREATE TABLE peer_messages (
        id TEXT PRIMARY KEY REFERENCES accepted_messages(id) ON DELETE CASCADE,
        owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        from_session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        to_session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        root_id TEXT NOT NULL,
        reply_to TEXT,
        digest TEXT NOT NULL
      );
      CREATE INDEX idx_peer_messages_root ON peer_messages(root_id);
    `)
  }
}
