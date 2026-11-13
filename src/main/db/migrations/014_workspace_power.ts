import type { Migration } from './index'

export const m014: Migration = {
  name: '014_workspace_power',
  up(db) {
    db.exec(`
      ALTER TABLE workspaces ADD COLUMN power_state TEXT NOT NULL DEFAULT 'stopped';
      ALTER TABLE workspaces ADD COLUMN power_error TEXT;
    `)
  }
}
