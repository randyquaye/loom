import { git } from './run'

/** Local branch names of a project repo, for the new-workspace "start from" picker. */
export async function listBranches(repoPath: string): Promise<string[]> {
  const out = await git(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * The branch a worktree is currently on, or null when HEAD is detached. Read from the
 * worktree rather than the stored row because a terminal session can switch branches.
 */
export async function currentBranch(repoPath: string): Promise<string | null> {
  const name = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return name === 'HEAD' || name === '' ? null : name
}
