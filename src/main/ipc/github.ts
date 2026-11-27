import type {
  BranchPrsResult,
  IntegrationBlocker,
  PullRequestListResult,
  WorkspacePrResult
} from '../../shared/ipc-contract'
import { getProjectOrThrow } from '../db/repos/projects'
import { getWorkspaceOrThrow, listWorkspaces } from '../db/repos/workspaces'
import {
  GH_AUTH_HINT,
  GH_INSTALL_HINT,
  GhNotAuthenticatedError,
  GhNotInstalledError
} from '../integrations/github/errors'
import { listPullRequests } from '../integrations/github/prs'
import { createRepositoryPrCache } from '../integrations/github/repository-prs'
import { aggregateWorkspacePrs } from '../../shared/workspace-prs'
import { knownWorkspaceBranches, refreshWorkspaceBranches } from '../workspace/worktree-tracking'
import { parseGithubRepo } from '../integrations/github/repo-ref'
import { ghExec, type GhExec } from '../integrations/github/gh'
import { handle, type Caller, type IpcDeps } from './registry'

/** Integration failures reach the renderer as data, so each one can render its own state. */
export function toBlocker(err: unknown): IntegrationBlocker {
  if (err instanceof GhNotInstalledError) return { kind: 'not-installed', hint: GH_INSTALL_HINT }
  if (err instanceof GhNotAuthenticatedError) return { kind: 'not-authenticated', hint: GH_AUTH_HINT }
  return { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
}

export function registerGithubIpc(
  deps: IpcDeps,
  forCaller?: (caller: Caller | undefined, workspaceId?: string) => Promise<GhExec>,
  mayView?: (caller: Caller, workspaceId: string) => boolean
): void {
  const cache = createRepositoryPrCache()
  const observations = new Map<string, string>()
  const visible = (caller: Caller | undefined, workspace: ReturnType<typeof getWorkspaceOrThrow>) =>
    caller === undefined || (mayView?.(caller, workspace.id) ?? workspace.ownerId === caller.userId)
  async function observe(workspace: ReturnType<typeof getWorkspaceOrThrow>) {
    const branches = await refreshWorkspaceBranches(deps.db, workspace, deps.dataRoot)
    const fingerprint = JSON.stringify(branches.map((row) => [row.branch, row.sessionId]).sort())
    const previous = observations.get(workspace.id)
    observations.set(workspace.id, fingerprint)
    return { branches, changed: previous !== undefined && previous !== fingerprint }
  }
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
      const groups = new Map<string, ReturnType<typeof listWorkspaces>>()
      for (const workspace of listWorkspaces(deps.db, projectId).filter((row) => visible(caller, row))) {
        const scope = workspace.ownerId ?? caller?.userId ?? 'local'
        groups.set(scope, [...(groups.get(scope) ?? []), workspace])
      }
      if (groups.size === 0) groups.set(caller?.userId ?? 'local', [])
      const repository = `${ref.owner}/${ref.repo}`
      const byBranch: Record<string, 'open' | 'merged'> = {}
      const byWorkspace: Record<string, 'open' | 'merged' | null> = {}
      let succeeded = false
      let failure: unknown
      for (const [scope, workspaces] of groups) {
        try {
          const exec = forCaller === undefined ? ghExec : await forCaller(caller, workspaces[0]?.id)
          const observed = new Map<string, Awaited<ReturnType<typeof observe>>>()
          for (const workspace of workspaces) {
            let value = { branches: knownWorkspaceBranches(deps.db, workspace.id), changed: false }
            if (workspace.state === 'ready' && !workspace.archived)
              value = await observe(workspace).catch(() => value)
            if (value.branches.length === 0)
              value.branches.push({
                branch: workspace.branch,
                path: workspace.worktreePath,
                sessionId: '',
                source: 'workspace'
              })
            observed.set(workspace.id, value)
          }
          const prs = await cache.list(
            ref,
            scope,
            exec,
            [...observed.values()].some((value) => value.changed)
          )
          succeeded = true
          if (!caller || scope === caller.userId)
            for (const branch of new Set(prs.map((pr) => pr.headRefName))) {
              const state = aggregateWorkspacePrs(prs, [branch], repository).state
              if (state) byBranch[branch] = state
            }
          for (const workspace of workspaces)
            if (visible(caller, workspace)) {
              byWorkspace[workspace.id] = aggregateWorkspacePrs(
                prs,
                observed.get(workspace.id)!.branches.map((row) => row.branch),
                repository
              ).state
            }
        } catch (error) {
          failure = error
        }
      }
      if (!succeeded) throw failure
      return { kind: 'ok', byBranch, byWorkspace }
    } catch (err) {
      return blocker(err)
    }
  })

  handle('github:workspacePr', async ({ workspaceId, refresh }, caller): Promise<WorkspacePrResult> => {
    const workspace = getWorkspaceOrThrow(deps.db, workspaceId)
    const ref = parseGithubRepo(getProjectOrThrow(deps.db, workspace.projectId).remoteUrl)
    if (ref === null) return { kind: 'no-remote' }
    try {
      const exec = forCaller === undefined ? ghExec : await forCaller(caller, workspaceId)
      const scope = workspace.ownerId ?? caller?.userId ?? 'local'
      const { branches, changed } = await observe(workspace)
      const prs = await cache.list(ref, scope, exec, refresh || changed)
      const associated = aggregateWorkspacePrs(
        prs,
        branches.map((row) => row.branch),
        `${ref.owner}/${ref.repo}`
      )
      const first = associated.pullRequests[0]
      const pullRequest = first ? await cache.detail(ref, first.number, scope, exec, refresh) : null
      const pullRequests = associated.pullRequests.map((pr) => ({
        ...pr,
        sessionIds: [
          ...new Set(
            branches
              .filter((row) => row.branch === pr.headRefName && row.sessionId)
              .map((row) => row.sessionId)
          )
        ]
      }))
      return { kind: 'ok', pullRequest, pullRequests, state: associated.state }
    } catch (err) {
      return blocker(err)
    }
  })
}
