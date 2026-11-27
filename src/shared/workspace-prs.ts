import type { BranchPrState, PullRequestSummary } from './ipc-contract'

export interface RepositoryPullRequest extends PullRequestSummary {
  headRepository: string | null
}

/** Association is exact repository plus branch, never title similarity or commit ancestry. */
export function aggregateWorkspacePrs(
  prs: readonly RepositoryPullRequest[],
  branches: readonly string[],
  repository: string
): { pullRequests: RepositoryPullRequest[]; state: BranchPrState | null } {
  const names = new Set(branches)
  const pullRequests = prs
    .filter(
      (pr) => names.has(pr.headRefName) && pr.headRepository?.toLowerCase() === repository.toLowerCase()
    )
    .sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.updatedAt - a.updatedAt)
  const state = pullRequests.some((pr) => pr.state === 'open')
    ? 'open'
    : pullRequests.length > 0 && pullRequests.every((pr) => pr.state === 'merged')
      ? 'merged'
      : null
  return { pullRequests, state }
}
