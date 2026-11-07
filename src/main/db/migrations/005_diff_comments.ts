import type Database from 'better-sqlite3'
import type { Migration } from './index'

export const m005: Migration = {
  name: '005_diff_comments',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE diff_comments (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX diff_comments_workspace ON diff_comments(workspace_id, path);
    `)
  }
}
