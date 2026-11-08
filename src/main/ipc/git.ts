import { makeWorktreeResolver } from '../fs/workspace-root'
import { getProjectOrThrow } from '../db/repos/projects'
import { listBranches } from '../git/branches'
import { diffFor, listChanges } from '../git/status'
import { diffCheckpoint, listCheckpoints, restoreCheckpoint, saveCheckpoint } from '../git/checkpoint'
import { handle, type IpcDeps } from './handle'

export function registerGitIpc(deps: IpcDeps): void {
  const worktreeOf = makeWorktreeResolver(deps.db)

  handle('git:branches', ({ projectId }) => listBranches(getProjectOrThrow(deps.db, projectId).repoPath))
  handle('git:status', ({ workspaceId }) => listChanges(worktreeOf(workspaceId)))
  handle('git:diff', ({ workspaceId, path }) => diffFor(worktreeOf(workspaceId), path))
  handle('git:checkpoints', ({ workspaceId }) => listCheckpoints(worktreeOf(workspaceId)))
  handle('git:saveCheckpoint', ({ workspaceId, label }) => saveCheckpoint(worktreeOf(workspaceId), label))
  handle('git:restoreCheckpoint', ({ workspaceId, id }) => restoreCheckpoint(worktreeOf(workspaceId), id))
  handle('git:diffCheckpoint', ({ workspaceId, id }) => diffCheckpoint(worktreeOf(workspaceId), id))
}
