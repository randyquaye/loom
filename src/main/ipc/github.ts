import type { IntegrationBlocker, PullRequestListResult, WorkspacePrResult } from '../../shared/ipc-contract'
import { getProjectOrThrow } from '../db/repos/projects'
import { getWorkspaceOrThrow } from '../db/repos/workspaces'
import { makeWorktreeResolver } from '../fs/workspace-root'
import { currentBranch } from '../git/branches'
import {
  GH_AUTH_HINT,
  GH_INSTALL_HINT,
  GhNotAuthenticatedError,
  GhNotInstalledError
} from '../integrations/github/errors'
import { findPullRequestForBranch, listPullRequests } from '../integrations/github/prs'
import { parseGithubRepo } from '../integrations/github/repo-ref'
import { handle, type IpcDeps } from './index'

/** Integration failures reach the renderer as data, so each one can render its own state. */
function toBlocker(err: unknown): IntegrationBlocker {
  if (err instanceof GhNotInstalledError) return { kind: 'not-installed', hint: GH_INSTALL_HINT }
  if (err instanceof GhNotAuthenticatedError) return { kind: 'not-authenticated', hint: GH_AUTH_HINT }
  return { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
}

export function registerGithubIpc(deps: IpcDeps): void {
  const worktreeOf = makeWorktreeResolver(deps.db)

  handle('github:prs', async ({ projectId, query }): Promise<PullRequestListResult> => {
    const ref = parseGithubRepo(getProjectOrThrow(deps.db, projectId).remoteUrl)
    if (ref === null) return { kind: 'no-remote' }
    try {
      return { kind: 'ok', pullRequests: await listPullRequests(ref, query) }
    } catch (err) {
      return toBlocker(err)
    }
  })

  handle('github:workspacePr', async ({ workspaceId }): Promise<WorkspacePrResult> => {
    const workspace = getWorkspaceOrThrow(deps.db, workspaceId)
    const ref = parseGithubRepo(getProjectOrThrow(deps.db, workspace.projectId).remoteUrl)
    if (ref === null) return { kind: 'no-remote' }
    try {
      // Read from the worktree, not the stored row: a terminal session can switch branches,
      // and a detached HEAD simply has no PR to find.
      const head = await currentBranch(worktreeOf(workspaceId))
      return { kind: 'ok', pullRequest: await findPullRequestForBranch(ref, head) }
    } catch (err) {
      return toBlocker(err)
    }
  })
}
