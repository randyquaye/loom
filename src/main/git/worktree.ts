import path from 'node:path'
import { lstat, realpath, rm } from 'node:fs/promises'
import { WORKSPACES_DIR, WORKTREE_BRANCH_PREFIX } from '../../shared/brand'
import { git } from './run'

export interface WorktreeEntry {
  path: string
  head: string
  branch: string | null
  bare: boolean
}

export interface AddedWorktree {
  path: string
  branch: string
}

export class WorktreePathEscapeError extends Error {
  readonly code = 'WORKTREE_PATH_ESCAPE'

  constructor(root: string, target: string) {
    super(`WORKTREE_PATH_ESCAPE: ${target} is outside ${root}`)
    this.name = 'WorktreePathEscapeError'
  }
}

export function workspaceBranch(slug: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${slug}`
}

export function workspacesRootFor(dataRoot: string, projectSlug: string): string {
  return path.resolve(dataRoot, WORKSPACES_DIR, projectSlug)
}

/** Worktrees are only ever created strictly inside `<dataRoot>/workspaces/<projectSlug>/`. */
export function assertInsideWorkspacesRoot(dataRoot: string, projectSlug: string, target: string): string {
  const root = workspacesRootFor(dataRoot, projectSlug)
  const resolved = path.resolve(target)
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new WorktreePathEscapeError(root, resolved)
  return resolved
}

export function worktreePathFor(dataRoot: string, projectSlug: string, slug: string): string {
  const root = workspacesRootFor(dataRoot, projectSlug)
  return assertInsideWorkspacesRoot(dataRoot, projectSlug, path.resolve(root, slug))
}

export async function addWorktree(
  repoPath: string,
  dataRoot: string,
  projectSlug: string,
  slug: string,
  baseRef: string | null = null
): Promise<AddedWorktree> {
  // Resolved and containment-checked before git creates anything on disk.
  const target = worktreePathFor(dataRoot, projectSlug, slug)
  const branch = workspaceBranch(slug)
  // baseRef lets a workspace start from an existing branch or PR head; the new
  // loom branch is created from it rather than from HEAD.
  const args =
    baseRef === null
      ? ['worktree', 'add', '-b', branch, '--', target]
      : ['worktree', 'add', '-b', branch, '--', target, baseRef]
  await git(repoPath, args)
  return { path: target, branch }
}

export async function removeWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  // A bootstrap that died before `git worktree add` succeeded leaves a row and perhaps a
  // directory but no registration, and `worktree remove` fatals on those. Clean by hand.
  if (await isRegisteredWorktree(repoPath, worktreePath)) {
    // The worktree must go first: git refuses to delete a branch that is checked out.
    await git(repoPath, ['worktree', 'remove', '--force', '--', worktreePath])
  } else {
    await git(repoPath, ['worktree', 'prune']).catch(() => {})
    await removeOrphanDir(worktreePath)
  }
  const hasBranch = await git(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false)
  if (hasBranch) await git(repoPath, ['branch', '-D', '--', branch])
}

const WORKTREE_LINE_PREFIX = 'worktree '.length

async function isRegisteredWorktree(repoPath: string, worktreePath: string): Promise<boolean> {
  const out = await git(repoPath, ['worktree', 'list', '--porcelain'])
  const real = await realpath(worktreePath).catch(() => worktreePath)
  return out.split('\n').some((line) => {
    if (!line.startsWith('worktree ')) return false
    const listed = line.slice(WORKTREE_LINE_PREFIX)
    return listed === worktreePath || listed === real
  })
}

/**
 * A bootstrap that died between inserting the row and a successful `git worktree add`
 * leaves footprints: a branch with no registered worktree, and a target dir git never
 * populated. Either makes the next attempt fatal ("a branch named ... already exists",
 * "already exists"), so clear both before adding. A dir that grew a .git of its own is
 * left alone: that is a repository we do not understand, not litter.
 */
export async function recoverStaleWorktree(
  repoPath: string,
  branch: string,
  worktreePath: string,
  log: (line: string) => Promise<void> = async () => {}
): Promise<void> {
  if (await isRegisteredWorktree(repoPath, worktreePath)) return
  const hasBranch = await git(repoPath, ['rev-parse', '--verify', `refs/heads/${branch}`])
    .then(() => true)
    .catch(() => false)
  if (hasBranch) {
    await log(`stale branch ${branch} has no registered worktree; deleting it`)
    await git(repoPath, ['branch', '-D', '--', branch])
  }
  const info = await lstat(worktreePath).catch(() => null)
  if (info === null || !info.isDirectory()) return
  const gitEntry = await lstat(path.join(worktreePath, '.git')).catch(() => null)
  if (gitEntry !== null) return
  await log(`leftover dir ${worktreePath} is not a checkout; removing it`)
  await rm(worktreePath, { recursive: true, force: true })
}

/**
 * Deletes a leftover directory at a workspace path git does not know about. Refuses when
 * it grew a .git of its own: that is a repository we do not understand, not litter.
 */
async function removeOrphanDir(worktreePath: string): Promise<void> {
  const info = await lstat(worktreePath).catch(() => null)
  if (info === null || !info.isDirectory()) return
  const gitEntry = await lstat(path.join(worktreePath, '.git')).catch(() => null)
  if (gitEntry !== null) {
    throw new Error(`refusing to delete unregistered worktree dir that contains .git: ${worktreePath}`)
  }
  await rm(worktreePath, { recursive: true, force: true })
}

export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  return parseWorktreeList(await git(repoPath, ['worktree', 'list', '--porcelain']))
}

/** git is the authority on ref syntax; exit status 1 means the name is unusable. */
export async function isValidBranchRef(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(repoPath, ['check-ref-format', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  return porcelain
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map(parseWorktreeBlock)
}

function parseWorktreeBlock(block: string): WorktreeEntry {
  let entryPath = ''
  let head = ''
  let branch: string | null = null
  let bare = false
  for (const line of block.split('\n')) {
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    switch (key) {
      case 'worktree':
        entryPath = value
        break
      case 'HEAD':
        head = value
        break
      case 'branch':
        branch = value.replace(/^refs\/heads\//, '')
        break
      case 'bare':
        bare = true
        break
      default:
        break
    }
  }
  return { path: entryPath, head, branch, bare }
}
