import type Database from 'better-sqlite3'
import type { Migration } from './index'

export const m003: Migration = {
  name: '003_workspace_runtime',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE workspaces ADD COLUMN state TEXT NOT NULL DEFAULT 'ready';
      ALTER TABLE workspaces ADD COLUMN port INTEGER;
      ALTER TABLE workspaces ADD COLUMN initialization_files_copied INTEGER;
      ALTER TABLE workspaces ADD COLUMN initialization_log_path TEXT;
      ALTER TABLE workspaces ADD COLUMN setup_log_path TEXT;
    `)
  }
}
