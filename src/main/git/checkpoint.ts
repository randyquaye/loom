import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CheckpointInfo } from '../../shared/ipc-contract'
import { git, gitRuntimeFor, gitWithEnv } from './run'

export const CHECKPOINT_REF_PREFIX = 'refs/loom/checkpoints/'
export const CHECKPOINT_CAP = 50

export class CheckpointBusyError extends Error {
  constructor(readonly reason: string) {
    super(`repository is busy (${reason}); checkpoint refused`)
    this.name = 'CheckpointBusyError'
  }
}

export class CheckpointRootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CheckpointRootError'
  }
}

export class CheckpointMissingError extends Error {
  constructor(id: string) {
    super(`unknown checkpoint ${id}`)
    this.name = 'CheckpointMissingError'
  }
}

const ID_RE = /^cp-\d+-[0-9a-f]{8}$/

function assertId(id: string): string {
  if (!ID_RE.test(id)) throw new CheckpointMissingError(id)
  return id
}

async function exists(p: string): Promise<boolean> {
  return lstat(p)
    .then(() => true)
    .catch(() => false)
}

/** git-prompt.sh-style detection: an in-flight operation must block saves and restores. */
async function busyReason(worktreePath: string): Promise<string | null> {
  const gitDir = path.resolve(worktreePath, await git(worktreePath, ['rev-parse', '--git-dir']))
  const dirChecks: Array<[string, string]> = [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert']
  ]
  for (const [name, reason] of dirChecks) {
    if (await exists(path.join(gitDir, name))) return reason
  }
  if (await exists(path.join(gitDir, 'SQUASH_MSG'))) {
    const unmerged = await git(worktreePath, ['ls-files', '-u'])
    if (unmerged !== '') return 'squash-merge'
  }
  return null
}

/** A workspace whose git root is an ancestor of its own path has no checkout of its own. */
async function assertOwnRoot(worktreePath: string): Promise<void> {
  const toplevel = path.resolve(await git(worktreePath, ['rev-parse', '--show-toplevel']))
  // realpath both sides: macOS hands out /var/folders/… but git reports /private/var/folders/…
  const [physRoot, physWorktree] = await Promise.all([realpath(toplevel), realpath(worktreePath)])
  if (physRoot !== physWorktree) {
    throw new CheckpointRootError(`git root ${toplevel} is not the workspace ${worktreePath}`)
  }
}

async function prune(worktreePath: string): Promise<void> {
  const list = await listCheckpoints(worktreePath)
  for (const old of list.slice(CHECKPOINT_CAP)) {
    await git(worktreePath, ['update-ref', '-d', CHECKPOINT_REF_PREFIX + old.id]).catch(() => {})
  }
}

/**
 * Non-disruptive save: stages the worktree (including untracked, honouring
 * info/exclude so .context/ stays out) into a throwaway index, writes a commit
 * as a standalone commit under its own private ref. HEAD, the real index and the
 * working tree never move.
 */
export async function saveCheckpoint(worktreePath: string, label: string): Promise<string> {
  await assertOwnRoot(worktreePath)
  const busy = await busyReason(worktreePath)
  if (busy !== null) throw new CheckpointBusyError(busy)
  const runtime = gitRuntimeFor(worktreePath)
  const tmp =
    runtime === null
      ? await mkdtemp(path.join(tmpdir(), 'loom-ckpt-'))
      : (await runtime.exec('mktemp', ['-d', '/tmp/loom-ckpt-XXXXXXXX'], { cwd: worktreePath })).stdout.trim()
  if (runtime !== null && !/^\/tmp\/loom-ckpt-[A-Za-z0-9_-]{1,128}$/.test(tmp))
    throw new Error('The container returned an invalid checkpoint temporary index directory')
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') }
  try {
    const hasHead = await git(worktreePath, ['rev-parse', '--verify', 'HEAD']).catch(() => '')
    if (hasHead !== '') await gitWithEnv(worktreePath, ['read-tree', 'HEAD'], env)
    await gitWithEnv(worktreePath, ['add', '-A', '--', '.'], env)
    const tree = await gitWithEnv(worktreePath, ['write-tree'], env)
    const id = `cp-${Date.now()}-${randomUUID().slice(0, 8)}`
    const ref = CHECKPOINT_REF_PREFIX + id
    const commit = await git(worktreePath, ['commit-tree', tree, '-m', label])
    await git(worktreePath, ['update-ref', ref, commit])
    await prune(worktreePath)
    return id
  } finally {
    if (runtime === null) await rm(tmp, { recursive: true, force: true })
    else await runtime.exec('rm', ['-rf', '--', tmp], { cwd: worktreePath })
  }
}

export async function listCheckpoints(worktreePath: string): Promise<CheckpointInfo[]> {
  const out = await git(worktreePath, [
    'for-each-ref',
    '--sort=-creatordate',
    '--format=%(refname:short)|%(creatordate:unix)|%(subject)',
    CHECKPOINT_REF_PREFIX
  ]).catch(() => '')
  if (out === '') return []
  const checkpoints: CheckpointInfo[] = []
  for (const line of out.split('\n')) {
    const [short, ts, ...label] = line.split('|')
    if (short === undefined || ts === undefined) continue
    const id = short.slice(short.lastIndexOf('/') + 1)
    if (!ID_RE.test(id)) continue
    checkpoints.push({ id, at: Number(ts) * 1000, label: label.join('|') })
  }
  return checkpoints
}

/**
 * Restores index + worktree to the checkpoint tree without moving HEAD or the
 * branch: `restore --source` re-stages and rewrites tracked content (including
 * files that were untracked when saved), then `clean -fd` drops untracked files
 * created afterwards. Ignored paths (.context/) survive clean.
 */
export async function restoreCheckpoint(worktreePath: string, id: string): Promise<void> {
  assertId(id)
  await assertOwnRoot(worktreePath)
  const busy = await busyReason(worktreePath)
  if (busy !== null) throw new CheckpointBusyError(busy)
  const ref = CHECKPOINT_REF_PREFIX + id
  await git(worktreePath, ['rev-parse', '--verify', ref]).catch(() => {
    throw new CheckpointMissingError(id)
  })
  await git(worktreePath, ['restore', '--source', ref, '--staged', '--worktree', '--', '.'])
  await git(worktreePath, ['clean', '-fd'])
}

/** Worktree-vs-checkpoint diff; empty string when identical. */
export async function diffCheckpoint(worktreePath: string, id: string): Promise<string> {
  assertId(id)
  return git(worktreePath, ['diff', '--no-ext-diff', CHECKPOINT_REF_PREFIX + id, '--'])
}
