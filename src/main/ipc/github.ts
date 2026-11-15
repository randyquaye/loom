import type {
  BranchPrsResult,
  IntegrationBlocker,
  PullRequestListResult,
  WorkspacePrResult
} from '../../shared/ipc-contract'
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
import { findPullRequestForBranch, listBranchPrStates, listPullRequests } from '../integrations/github/prs'
import { parseGithubRepo } from '../integrations/github/repo-ref'
import type { GhExec } from '../integrations/github/gh'
import { handle, type Caller, type IpcDeps } from './registry'

/** Integration failures reach the renderer as data, so each one can render its own state. */
export function toBlocker(err: unknown): IntegrationBlocker {
  if (err instanceof GhNotInstalledError) return { kind: 'not-installed', hint: GH_INSTALL_HINT }
  if (err instanceof GhNotAuthenticatedError) return { kind: 'not-authenticated', hint: GH_AUTH_HINT }
  return { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
}

export function registerGithubIpc(
  deps: IpcDeps,
  forCaller?: (caller: Caller | undefined, workspaceId?: string) => Promise<GhExec>
): void {
  const worktreeOf = makeWorktreeResolver(deps.db)
  function blocker(error: unknown): IntegrationBlocker {
    if (forCaller !== undefined && error instanceof GhNotAuthenticatedError)
      return {
        kind: 'not-authenticated',
        hint: 'Connect GitHub in Loom: Settings, Integrations, Cloud.'
      }
    if (forCaller !== undefined && error instanceof GhNotInstalledError)
      return {
        kind: 'failed',
        message: 'GitHub CLI is unavailable on the cloud runner. Contact the runner owner.'
      }
    return toBlocker(error)
  }

  handle('github:prs', async ({ projectId, query, cloud }, caller): Promise<PullRequestListResult> => {
    if (cloud && forCaller === undefined)
      return { kind: 'failed', message: 'Connect to Cloud to read cloud pull requests.' }
    const ref = parseGithubRepo(getProjectOrThrow(deps.db, projectId).remoteUrl)
    if (ref === null) return { kind: 'no-remote' }
    try {
      const pullRequests =
        forCaller === undefined
          ? await listPullRequests(ref, query)
          : await listPullRequests(ref, query, await forCaller(caller))
      return { kind: 'ok', pullRequests }
    } catch (err) {
      return blocker(err)
    }
  })

  handle('github:branchPrs', async ({ projectId, cloud }, caller): Promise<BranchPrsResult> => {
    if (cloud && forCaller === undefined)
      return { kind: 'failed', message: 'Connect to Cloud to read cloud pull requests.' }
    const ref = parseGithubRepo(getProjectOrThrow(deps.db, projectId).remoteUrl)
    if (ref === null) return { kind: 'no-remote' }
    try {
      const byBranch =
        forCaller === undefined
          ? await listBranchPrStates(ref)
          : await listBranchPrStates(ref, await forCaller(caller))
      return { kind: 'ok', byBranch }
    } catch (err) {
      return blocker(err)
    }
  })

  handle('github:workspacePr', async ({ workspaceId }, caller): Promise<WorkspacePrResult> => {
    const workspace = getWorkspaceOrThrow(deps.db, workspaceId)
    const ref = parseGithubRepo(getProjectOrThrow(deps.db, workspace.projectId).remoteUrl)
    if (ref === null) return { kind: 'no-remote' }
    try {
      // Read from the worktree, not the stored row: a terminal session can switch branches,
      // and a detached HEAD simply has no PR to find.
      const head = await currentBranch(worktreeOf(workspaceId))
      const pullRequest =
        forCaller === undefined
          ? await findPullRequestForBranch(ref, head)
          : await findPullRequestForBranch(ref, head, await forCaller(caller, workspaceId))
      return { kind: 'ok', pullRequest }
    } catch (err) {
      return blocker(err)
    }
  })
}
