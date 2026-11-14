import type { Migration } from './index'

export const m015: Migration = {
  name: '015_notifications',
  up(db) {
    // A notification about a workspace goes when the workspace does.
    db.exec(`
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        closed_at INTEGER,
        payload TEXT NOT NULL
      );
      CREATE INDEX idx_notifications_owner ON notifications(owner_id, created_at);
    `)
  }
}
