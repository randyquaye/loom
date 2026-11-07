import type Database from 'better-sqlite3'

export class UnknownWorkspaceError extends Error {
  override readonly name = 'UnknownWorkspaceError'
}

export type WorktreeResolver = (workspaceId: string) => string

export function makeWorktreeResolver(db: Database.Database): WorktreeResolver {
  const stmt = db.prepare<[string], { worktree_path: string }>(
    'SELECT worktree_path FROM workspaces WHERE id = ?'
  )
  return (workspaceId) => {
    const row = stmt.get(workspaceId)
    if (row === undefined) throw new UnknownWorkspaceError(`unknown workspace: ${workspaceId}`)
    return row.worktree_path
  }
}
