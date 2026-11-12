import type { Migration } from './index'

export const m009: Migration = {
  name: '009_workspace_placement',
  up(db) {
    db.exec(`
      ALTER TABLE workspaces ADD COLUMN checkout TEXT NOT NULL DEFAULT 'worktree';
      ALTER TABLE workspaces ADD COLUMN runtime TEXT NOT NULL DEFAULT 'machine';
    `)
  }
}
