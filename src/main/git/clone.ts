import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { WORKSPACES_DIR } from '../../shared/brand'
import { assertSafeBaseRef, BaseRefUnavailableError, refreshBaseRef, resolveBaseRef } from './baseref'
import { git, gitWithEnv } from './run'

export interface CloneInput {
  /** Where git reads the repository from: a local repository path or a remote URL. */
  source: string
  target: string
  branch: string
  /** Branch, tag or commit to start from; null uses origin's default branch, or local HEAD. */
  baseRef: string | null
  /** The address the clone pushes to and fetches from, when that is not `source`. */
  originUrl: string | null
  /**
   * Extra environment for the git calls that reach the remote, such as its owner's access to
   * a private repository. It exists only while those calls run; nothing of it is written
   * into the clone, which the workspace's own code can read.
   */
  remoteEnv?: Record<string, string>
}

export class WorkspacePathRejectedError extends Error {
  readonly code = 'WORKSPACE_PATH_REJECTED'

  constructor(target: string, why: string) {
    super(`WORKSPACE_PATH_REJECTED: ${target} ${why}`)
    this.name = 'WorkspacePathRejectedError'
  }
}

/**
 * The hardening args refuse the file transport, which is what a clone from a local path
 * uses. A local source is the project repository the user registered, so it alone is let
 * through; URLs keep the full hardening.
 */
const LOCAL_SOURCE_ARGS = ['-c', 'protocol.file.allow=always'] as const

/** What a worktree shares with its repository and a clone would otherwise lose. */
const IDENTITY_KEYS = ['user.name', 'user.email'] as const

async function resolvesToCommit(repoPath: string, ref: string): Promise<boolean> {
  return git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    .then(() => true)
    .catch(() => false)
}

/**
 * A fresh clone holds the source's branches as origin/NAME. A branch the source does not
 * have, such as a pull request head that exists only on the real remote, is fetched from
 * origin, which by now is that remote.
 */
async function resolveStartPoint(
  target: string,
  baseRef: string,
  canFetch: boolean,
  remoteEnv: Record<string, string>
): Promise<string> {
  assertSafeBaseRef(baseRef)
  for (const candidate of [baseRef, `refs/remotes/origin/${baseRef}`]) {
    if (await resolvesToCommit(target, candidate)) return candidate
  }
  if (canFetch) return resolveBaseRef(target, baseRef, (repo, args) => gitWithEnv(repo, args, remoteEnv))
  throw new BaseRefUnavailableError(baseRef, 'the repository has no such branch, tag or commit')
}

/** Commits made in the clone, checkpoints included, are attributed as they are in the source. */
async function copyIdentity(source: string, target: string): Promise<void> {
  for (const key of IDENTITY_KEYS) {
    const value = await git(source, ['config', '--get', key]).catch(() => '')
    if (value !== '') await git(target, ['config', key, value])
  }
}

/**
 * A self-contained checkout: every object, ref and config entry lives under `target`, so the
 * folder can be handed to a container on its own. A worktree cannot, because its git data
 * stays in the main repository.
 */
export async function addClone({
  source,
  target,
  branch,
  baseRef,
  originUrl,
  remoteEnv = {}
}: CloneInput): Promise<void> {
  const parent = path.dirname(target)
  await mkdir(parent, { recursive: true })
  const local = path.isAbsolute(source)
  // --no-checkout defers writing files to the hardened checkout below. --dissociate copies in
  // anything the source itself borrows from another repository, which would be out of reach.
  await gitWithEnv(
    parent,
    [...(local ? LOCAL_SOURCE_ARGS : []), 'clone', '--no-checkout', '--dissociate', '--', source, target],
    remoteEnv
  )
  if (local) await copyIdentity(source, target)
  const remote = originUrl !== null && originUrl !== source
  if (remote) await git(target, ['remote', 'set-url', 'origin', originUrl])
  const canFetch = remote || !local
  const refreshed = canFetch
    ? await refreshBaseRef(target, baseRef, (repo, args) => gitWithEnv(repo, args, remoteEnv))
    : baseRef
  const start = refreshed === null ? [] : [await resolveStartPoint(target, refreshed, canFetch, remoteEnv)]
  // --no-track: the workspace branch is new work, pushed under its own name.
  await git(target, ['checkout', '-q', '--no-track', '-b', branch, ...start, '--'])
}

/** The branch the source had checked out when it was cloned. */
export async function cloneDefaultBranch(target: string): Promise<string | null> {
  const ref = await git(target, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '')
  return ref.startsWith('origin/') ? ref.slice('origin/'.length) : null
}

/**
 * A recursive delete takes its target from a database row, so the row is not trusted: the
 * folder must be exactly `<data root>/workspaces/<project>/<slug>` once every `..` and
 * symlink is resolved. Returns the path to delete, or null when there is nothing there.
 */
async function ownedWorkspaceFolder(target: string, dataRoot: string): Promise<string | null> {
  const reject = (why: string): never => {
    throw new WorkspacePathRejectedError(target, why)
  }
  const root = path.resolve(dataRoot, WORKSPACES_DIR)
  if (!path.isAbsolute(target) || path.resolve(target) !== target) reject('is not a plain absolute path')
  const depth = path.relative(root, target).split(path.sep)
  if (depth.length !== 2 || depth.includes('..') || depth.includes('')) {
    reject(`is not a workspace folder under ${root}`)
  }
  const leaf = await lstat(target).catch(() => null)
  if (leaf === null) return null
  if (leaf.isSymbolicLink() || !leaf.isDirectory()) reject('is not a folder')
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(path.dirname(target))])
  if (path.dirname(realParent) !== realRoot) reject('is reached through a link that leaves the data root')
  return path.join(realParent, path.basename(target))
}

/** Deleting the folder is the whole removal: the branch and its checkpoints lived only there. */
export async function removeClone(target: string, dataRoot: string | undefined): Promise<void> {
  if (dataRoot === undefined) {
    throw new WorkspacePathRejectedError(target, 'cannot be checked without the data root')
  }
  const folder = await ownedWorkspaceFolder(target, dataRoot)
  if (folder !== null) await rm(folder, { recursive: true, force: true })
}
