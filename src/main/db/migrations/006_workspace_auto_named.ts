import type Database from 'better-sqlite3'
import type { Migration } from './index'

export const m006: Migration = {
  name: '006_workspace_auto_named',
  up(db: Database.Database) {
    // Display names start life auto-derived from the first prompt; while the flag is set a
    // model-computed name may replace them once. Clearing it (here, by the model rename
    // itself; later, by any manual rename) protects the name forever after.
    db.exec(`
      ALTER TABLE workspaces ADD COLUMN auto_named INTEGER NOT NULL DEFAULT 1;
    `)
  }
}
