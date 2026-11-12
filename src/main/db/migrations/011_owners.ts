import type { Migration } from './index'

export const m011: Migration = {
  name: '011_owners',
  up(db) {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );

      ALTER TABLE workspaces ADD COLUMN owner_id TEXT REFERENCES users(id);
      CREATE INDEX idx_workspaces_owner ON workspaces(owner_id);
    `)
  }
}
