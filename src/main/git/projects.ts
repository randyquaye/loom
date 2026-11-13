import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { REPOS_DIR, WORKSPACES_DIR } from '../../shared/brand'
import type { ProjectRow } from '../../shared/ipc-contract'
import { git } from './run'
import { slugify } from './slug'

export class ProjectPathNotFoundError extends Error {
  readonly code = 'PROJECT_PATH_NOT_FOUND'

  constructor(target: string) {
    super(`PROJECT_PATH_NOT_FOUND: ${target} does not exist or is not a directory`)
    this.name = 'ProjectPathNotFoundError'
  }
}

export class NotAGitRepositoryError extends Error {
  readonly code = 'NOT_A_GIT_REPOSITORY'

  constructor(target: string) {
    // Loom never runs `git init` on a user's folder, so this has to say why it stopped.
    super(`NOT_A_GIT_REPOSITORY: ${target} is not inside a git working tree`)
    this.name = 'NotAGitRepositoryError'
  }
}

export class ProjectUrlRejectedError extends Error {
  readonly code = 'PROJECT_URL_REJECTED'

  constructor(detail: string) {
    super(`PROJECT_URL_REJECTED: ${detail}`)
    this.name = 'ProjectUrlRejectedError'
  }
}

export class ProjectLocationExistsError extends Error {
  readonly code = 'PROJECT_LOCATION_EXISTS'

  constructor(target: string) {
    super(`PROJECT_LOCATION_EXISTS: ${target} already exists; overwrite replaces it with a fresh clone`)
    this.name = 'ProjectLocationExistsError'
  }
}

// Transports that execute local commands or read the local filesystem instead of fetching.
const BLOCKED_TRANSPORTS = ['ext::', 'fd::', 'file::'] as const
const ALLOWED_PROTOCOLS = new Set(['https:', 'ssh:'])
const SCP_STYLE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:.+$/

/** Only https and ssh remotes may be cloned; local paths and command transports are refused. */
export function assertCloneableUrl(url: string): void {
  if (url.startsWith('-')) throw new ProjectUrlRejectedError('a URL must not start with "-"')
  const lowered = url.toLowerCase()
  for (const blocked of BLOCKED_TRANSPORTS) {
    if (lowered.startsWith(blocked)) {
      throw new ProjectUrlRejectedError(`the ${blocked} transport is not allowed`)
    }
  }
  if (SCP_STYLE.test(url)) return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ProjectUrlRejectedError('not a valid https or ssh URL')
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new ProjectUrlRejectedError(`the ${parsed.protocol} transport is not allowed; use https or ssh`)
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function isGitWorkTree(target: string): Promise<boolean> {
  try {
    return (await git(target, ['rev-parse', '--is-inside-work-tree'])) === 'true'
  } catch {
    return false
  }
}

/** A missing origin is null; an unreadable repository must not erase its saved remote. */
export async function originUrl(repoPath: string): Promise<string | null> {
  const remotes = await git(repoPath, ['remote'])
  if (!remotes.split('\n').includes('origin')) return null
  return git(repoPath, ['remote', 'get-url', 'origin'])
}

/** Knows whether a repository path already belongs to another project row. */
export type RepoTaken = (candidate: string) => boolean

/** True when the repository lives under the app's repos dir: Loom cloned or created it. */
export function isAppOwnedRepo(dataRoot: string, repoPath: string): boolean {
  return path.resolve(repoPath).startsWith(path.join(dataRoot, REPOS_DIR) + path.sep)
}

/**
 * Clone slots under <dataRoot>/repos belong to the app: a leftover there from a removed
 * project may be replaced, but only when the user chose to. A folder another project row
 * references is live, and anything outside the repos dir is the user's property — both
 * stay untouched no matter what.
 */
export async function resolveCloneTarget(
  dataRoot: string,
  target: string,
  overwrite: boolean,
  isTaken: RepoTaken
): Promise<void> {
  if (!(await isDirectory(target))) return
  const resolved = path.resolve(target)
  if (isTaken(resolved)) {
    throw new ProjectLocationRejectedError(`${resolved} is the repository of another project`)
  }
  if (!isAppOwnedRepo(dataRoot, resolved)) {
    throw new ProjectLocationRejectedError(`${resolved} already exists`)
  }
  if (!overwrite) throw new ProjectLocationExistsError(resolved)
  await rm(resolved, { recursive: true, force: true })
}

/** Deletes an app-owned clone once its project row is gone; reports whether it deleted. */
export async function deleteOwnedRepo(
  dataRoot: string,
  repoPath: string,
  isTaken: RepoTaken
): Promise<boolean> {
  const resolved = path.resolve(repoPath)
  if (!isAppOwnedRepo(dataRoot, resolved)) return false
  if (isTaken(resolved)) return false
  await rm(resolved, { recursive: true, force: true })
  return true
}

/** Adopts an existing working tree; the repository root is stored, not the picked subdirectory. */
export async function addProjectFromLocalPath(
  dataRoot: string,
  name: string,
  localPath: string
): Promise<ProjectRow> {
  // realpath first, so a symlink cannot make the later checks and the stored path disagree.
  const picked = await realpath(localPath).catch((): null => null)
  if (picked === null || !(await isDirectory(picked))) {
    throw new ProjectPathNotFoundError(localPath)
  }
  if (!(await isGitWorkTree(picked))) throw new NotAGitRepositoryError(picked)
  const repoPath = await git(picked, ['rev-parse', '--show-toplevel'])
  await mkdir(path.join(dataRoot, WORKSPACES_DIR, slugify(name)), { recursive: true })
  return {
    id: randomUUID(),
    name,
    repoPath,
    remoteUrl: await originUrl(repoPath).catch(() => null),
    createdAt: Date.now(),
    customPromptGeneral: null,
    customPromptCodeReview: null,
    customPromptFixErrors: null
  }
}

/** Clones into `<dataRoot>/repos/<slug>`; the app owns that copy, so removal may delete it. */
export async function addProjectFromClone(
  dataRoot: string,
  name: string,
  url: string,
  isTaken: RepoTaken = () => false
): Promise<ProjectRow> {
  assertCloneableUrl(url)
  const slug = slugify(name)
  const reposDir = path.join(dataRoot, REPOS_DIR)
  await mkdir(reposDir, { recursive: true })
  const target = path.join(reposDir, slug)
  await resolveCloneTarget(dataRoot, target, false, isTaken)
  // --no-checkout keeps clone from running the remote's post-checkout hook; the checkout
  // below happens through our hardened invocation instead.
  await git(reposDir, ['clone', '--no-checkout', '--', url, target])
  await git(target, ['checkout', '-f'])
  await mkdir(path.join(dataRoot, WORKSPACES_DIR, slug), { recursive: true })
  return {
    id: randomUUID(),
    name,
    repoPath: target,
    remoteUrl: url,
    createdAt: Date.now(),
    customPromptGeneral: null,
    customPromptCodeReview: null,
    customPromptFixErrors: null
  }
}

export class ProjectLocationRejectedError extends Error {
  readonly code = 'PROJECT_LOCATION_REJECTED'

  constructor(detail: string) {
    super(`PROJECT_LOCATION_REJECTED: ${detail}`)
    this.name = 'ProjectLocationRejectedError'
  }
}

/** Quick start: an empty repository under the app's repos dir, ready for workspaces. */
export async function initEmptyRepo(dataRoot: string, name: string): Promise<ProjectRow> {
  const reposDir = path.join(dataRoot, REPOS_DIR)
  await mkdir(reposDir, { recursive: true })
  const slug = slugify(name) || 'quickstart'
  const target = path.join(reposDir, slug)
  if (await isDirectory(target)) throw new ProjectLocationRejectedError(`${target} already exists`)
  await git(reposDir, ['init', '-b', 'main', '--', slug])
  // An unborn HEAD cannot have worktrees cut from it, so the quick start seeds one
  // commit immediately rather than leaving the first workspace to fail bootstrap.
  await writeFile(path.join(target, 'README.md'), `# ${slug}\n\nCreated by Loom quick start.\n`, 'utf8')
  await git(target, ['add', 'README.md'])
  await git(target, [
    '-c',
    'user.name=Loom',
    '-c',
    'user.email=loom@localhost',
    'commit',
    '-q',
    '-m',
    'Loom quick start'
  ])
  await mkdir(path.join(dataRoot, WORKSPACES_DIR, slug), { recursive: true })
  return {
    id: randomUUID(),
    name: slug,
    repoPath: target,
    remoteUrl: null,
    createdAt: Date.now(),
    customPromptGeneral: null,
    customPromptCodeReview: null,
    customPromptFixErrors: null
  }
}

function repoSlugFromUrl(url: string): string {
  const cleaned = url.replace(/\.git$/, '').replace(/\/+$/, '')
  const last = cleaned.split('/').pop() ?? cleaned.split(':').pop() ?? 'repo'
  return slugify(last) || 'repo'
}

/** Clones into a user-chosen folder, or the app's repos dir when location is null. */
export async function cloneToLocation(
  dataRoot: string,
  url: string,
  location: string | null,
  overwrite = false,
  isTaken: RepoTaken = () => false
): Promise<ProjectRow> {
  assertCloneableUrl(url)
  const slug = repoSlugFromUrl(url)
  let destDir: string
  if (location === null) {
    destDir = path.join(dataRoot, REPOS_DIR)
  } else {
    if (!path.isAbsolute(location)) {
      throw new ProjectLocationRejectedError('location must be an absolute path')
    }
    const resolved = path.resolve(location)
    const workspacesRoot = path.join(dataRoot, WORKSPACES_DIR)
    if (resolved === workspacesRoot || resolved.startsWith(workspacesRoot + path.sep)) {
      throw new ProjectLocationRejectedError('clones may not live inside the workspaces directory')
    }
    destDir = resolved
  }
  await mkdir(destDir, { recursive: true })
  const target = path.join(destDir, slug)
  await resolveCloneTarget(dataRoot, target, overwrite, isTaken)
  await git(destDir, ['clone', '--no-checkout', '--', url, target])
  await git(target, ['checkout', '-f'])
  await mkdir(path.join(dataRoot, WORKSPACES_DIR, slug), { recursive: true })
  return {
    id: randomUUID(),
    name: slug,
    repoPath: target,
    remoteUrl: url,
    createdAt: Date.now(),
    customPromptGeneral: null,
    customPromptCodeReview: null,
    customPromptFixErrors: null
  }
}
