import type { Migration } from './index'

export const m021: Migration = {
  name: '021_workspace_branches',
  up(db) {
    db.exec(`CREATE TABLE workspace_branches (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      branch TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT '',
      worktree_path TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('workspace','registered','discovered')),
      observed_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, branch, session_id)
    )`)
  }
}
