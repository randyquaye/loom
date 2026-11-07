import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type Database from 'better-sqlite3'
import { CONTEXT_DIR, WORKTREE_BRANCH_PREFIX } from '../../shared/brand'
import type { WorkspaceRow, WorkspaceState } from '../../shared/ipc-contract'
import { MAX_WORKSPACES_PER_PROJECT } from '../../shared/limits'
import { readRepoSettings } from '../config/repo-settings'
import { getProjectOrThrow } from '../db/repos/projects'
import {
  allocatePort,
  countWorkspaces,
  deleteWorkspace,
  getWorkspaceOrThrow,
  insertWorkspace,
  repoBranchTaken,
  setWorkspaceRuntime,
  setWorkspaceState
} from '../db/repos/workspaces'
import { ensureContextIgnored } from '../git/exclude'
import { resolveBaseRef } from '../git/baseref'
import { envOverlay } from '../env/vars'
import { git } from '../git/run'
import { allocateSlug, slugify } from '../git/slug'
import {
  addWorktree,
  isValidBranchRef,
  recoverStaleWorktree,
  removeWorktree,
  worktreePathFor,
  workspaceBranch
} from '../git/worktree'
import { copyWorkspaceFiles, resolveIncludeGlobs } from './copyfiles'
import { assertValidWorkspaceName, WorkspaceNameError } from './name'

const execFileAsync = promisify(execFile)
const SETUP_MAX_BYTES = 8 * 1024 * 1024

type StateSink = (push: { workspaceId: string; state: WorkspaceState; name?: string }) => void

let stateSink: StateSink | null = null

/** Wired by main once the window exists; bootstrap pushes state transitions through it. */
export function setWorkspaceStateSink(fn: StateSink): void {
  stateSink = fn
}

function pushState(workspaceId: string, state: WorkspaceState): void {
  stateSink?.({ workspaceId, state })
}

/** Pushes the live row (state plus display name) so model renames reach the sidebar live. */
export function announceWorkspace(db: Database.Database, workspaceId: string): void {
  const row = getWorkspaceOrThrow(db, workspaceId)
  stateSink?.({ workspaceId, state: row.state, name: row.name })
}

export class WorkspaceLimitError extends Error {
  readonly code = 'WORKSPACE_LIMIT'

  constructor(projectName: string, limit: number) {
    // The code rides in the message: Electron's IPC boundary keeps only the text.
    super(`WORKSPACE_LIMIT: "${projectName}" already has the maximum of ${limit} workspaces`)
    this.name = 'WorkspaceLimitError'
  }
}

export class WorkspaceNameTakenError extends Error {
  readonly code = 'WORKSPACE_NAME_TAKEN'

  constructor(projectName: string, name: string) {
    super(`WORKSPACE_NAME_TAKEN: "${projectName}" already has a workspace called "${name}"`)
    this.name = 'WorkspaceNameTakenError'
  }
}

export class WorkspaceNotReadyError extends Error {
  readonly code = 'WORKSPACE_NOT_READY'

  constructor(workspaceId: string, state: string) {
    super(
      `WORKSPACE_NOT_READY: workspace ${workspaceId} cannot run a turn (state: ${state}); remove it or wait for setup to finish, then send again`
    )
    this.name = 'WorkspaceNotReadyError'
  }
}

const SETTLE_TIMEOUT_MS = 180_000

/**
 * The db row is the source of truth for bootstrap progress, so waiting is a poll, not a
 * subscription. Sends gate on this: a prompt that reaches a half-built worktree spawns the
 * CLI in a directory that is not a checkout, which codex answers with its trusted-dir refusal.
 */
export async function waitForWorkspaceSettled(
  db: Database.Database,
  workspaceId: string,
  timeoutMs: number = SETTLE_TIMEOUT_MS
): Promise<WorkspaceRow> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = getWorkspaceOrThrow(db, workspaceId)
    if (row.state === 'ready' || row.state === 'error') return row
    if (Date.now() > deadline) throw new WorkspaceNotReadyError(workspaceId, row.state)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const CONTEXT_README = `# ${CONTEXT_DIR}

Notes, plans and reference material for this workspace. Loom creates this folder
for every workspace and excludes it through \`.git/info/exclude\`, so nothing in
here is committed or shared with the rest of the repository.
`

export interface CreateWorkspaceInput {
  db: Database.Database
  dataRoot: string
  projectId: string
  name: string
  baseRef?: string | null
}

export interface RemoveWorkspaceInput {
  db: Database.Database
  repoPath: string
  workspace: WorkspaceRow
}

export async function seedContextDir(worktreePath: string): Promise<void> {
  const { lstat } = await import('node:fs/promises')
  const dir = path.join(worktreePath, CONTEXT_DIR)
  const readme = path.join(dir, 'README.md')
  // A tracked symlink at either path would redirect these writes outside the
  // worktree, so refuse instead of following it.
  for (const target of [dir, readme]) {
    const existing = await lstat(target).catch(() => null)
    if (existing !== null && existing.isSymbolicLink()) {
      throw new Error(`refusing to seed .context through a symlink: ${target}`)
    }
  }
  await mkdir(dir, { recursive: true })
  await writeFile(readme, CONTEXT_README, 'utf8')
}

/**
 * Quick-start repos begin life unborn, and git cannot cut a worktree from an unborn
 * HEAD — which is exactly how every quickstart workspace ended in the error state.
 * Give such a repo one initial commit first; repos with history are untouched.
 */
export async function ensureInitialCommit(
  repoPath: string,
  log: (line: string) => Promise<void> = async () => {}
): Promise<void> {
  const hasHead = await git(repoPath, ['rev-parse', '--verify', 'HEAD'])
    .then(() => true)
    .catch(() => false)
  if (hasHead) return
  await log('repo has no commits yet; creating an initial commit')
  await git(repoPath, ['add', '-A'])
  await git(repoPath, [
    '-c',
    'user.name=Loom',
    '-c',
    'user.email=loom@localhost',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'Loom quick start'
  ])
}

export async function workspaceEnv(
  db: Database.Database,
  workspaceId: string
): Promise<Record<string, string>> {
  const workspace = getWorkspaceOrThrow(db, workspaceId)
  const project = getProjectOrThrow(db, workspace.projectId)
  const defaultBranch = await git(project.repoPath, ['symbolic-ref', '--short', 'HEAD']).catch(() => 'main')
  return {
    LOOM_WORKSPACE_NAME: workspace.name,
    LOOM_WORKSPACE_ID: workspace.id,
    LOOM_WORKSPACE_PATH: workspace.worktreePath,
    LOOM_ROOT_PATH: project.repoPath,
    LOOM_DEFAULT_BRANCH: defaultBranch,
    LOOM_PORT: workspace.port === null ? '' : String(workspace.port),
    LOOM_IS_LOCAL: '1',
    // User variables last; LOOM_* names are reserved, so nothing above can be shadowed.
    ...(await envOverlay(project.id))
  }
}

/**
 * Creates the row first (state `initializing`, port allocated) and returns it,
 * then initializes in the background: worktree, context seed, files-to-copy,
 * setup script. A slow setup never blocks the UI; failures land in state
 * `error` with the init/setup logs on disk.
 */
export async function createWorkspace({
  db,
  dataRoot,
  projectId,
  name,
  baseRef = null
}: CreateWorkspaceInput): Promise<WorkspaceRow> {
  const project = getProjectOrThrow(db, projectId)
  assertValidWorkspaceName(name)
  const slug = allocateSlug(slugify(name), (candidate) =>
    repoBranchTaken(db, project.repoPath, workspaceBranch(candidate))
  )
  const branch = workspaceBranch(slug)
  if (!(await isValidBranchRef(project.repoPath, branch))) {
    throw new WorkspaceNameError(`"${name}" cannot be used as the git ref ${branch}`)
  }
  const workspace: WorkspaceRow = {
    id: randomUUID(),
    projectId,
    name,
    branch,
    worktreePath: worktreePathFor(dataRoot, slugify(project.name), slug),
    createdAt: Date.now(),
    archived: false,
    state: 'initializing',
    port: allocatePort(db),
    initializationFilesCopied: null,
    setupLogPath: null
  }
  try {
    // Count and insert atomically so two concurrent creates cannot both pass
    // the per-project cap.
    db.transaction(() => {
      if (countWorkspaces(db, projectId) >= MAX_WORKSPACES_PER_PROJECT) {
        throw new WorkspaceLimitError(project.name, MAX_WORKSPACES_PER_PROJECT)
      }
      insertWorkspace(db, workspace)
    })()
  } catch (err) {
    if (isUniqueViolation(err)) throw new WorkspaceNameTakenError(project.name, name)
    throw err
  }
  void initializeWorkspace({
    db,
    dataRoot,
    projectSlug: slugify(project.name),
    repoPath: project.repoPath,
    workspace,
    baseRef
  })
  return workspace
}

interface InitializeInput {
  db: Database.Database
  dataRoot: string
  projectSlug: string
  repoPath: string
  workspace: WorkspaceRow
  baseRef: string | null
}

async function initializeWorkspace(input: InitializeInput): Promise<void> {
  const { db, repoPath, workspace } = input
  // Under the data root, not /tmp: macOS clears temp on reboot, and a log that vanishes
  // leaves the next failure undiagnosable ("setup log: unavailable").
  const logDir = path.join(input.dataRoot, 'logs', workspace.id)
  await mkdir(logDir, { recursive: true })
  const initLog = path.join(logDir, 'init.log')
  setWorkspaceRuntime(db, workspace.id, { initLog })
  const log = async (line: string) => {
    await appendFile(initLog, `${new Date().toISOString()} ${line}\n`).catch(() => {})
  }
  try {
    const slug = workspace.branch.slice(WORKTREE_BRANCH_PREFIX.length)
    await ensureInitialCommit(repoPath, log)
    // A base ref picked from a GitHub PR head usually exists only on origin, so it is
    // resolved (fetching if needed) before git is asked to start a worktree from it.
    let baseRef = input.baseRef
    if (baseRef !== null) {
      await log(`resolve base ref ${baseRef}`)
      baseRef = await resolveBaseRef(repoPath, baseRef)
      await log(`base ref -> ${baseRef}`)
    }
    // A bootstrap that died mid-add leaves a branch and a husk dir behind; both make
    // `git worktree add` fatal on the next attempt, so clear them before trying again.
    await recoverStaleWorktree(repoPath, workspace.branch, workspace.worktreePath, log)
    await log(`worktree add ${workspace.branch} -> ${workspace.worktreePath}`)
    await addWorktree(repoPath, input.dataRoot, input.projectSlug, slug, baseRef)
    await seedContextDir(workspace.worktreePath)
    await ensureContextIgnored(repoPath)
    const settings = await readRepoSettings(repoPath)
    const globs = await resolveIncludeGlobs(repoPath, settings)
    const copied = await copyWorkspaceFiles(repoPath, workspace.worktreePath, globs)
    setWorkspaceRuntime(db, workspace.id, { copied })
    await log(`copied ${copied} file(s)`)
    setWorkspaceState(db, workspace.id, 'setting_up')
    pushState(workspace.id, 'setting_up')
    if (settings.setup !== null) {
      const setupLog = path.join(logDir, 'setup.log')
      setWorkspaceRuntime(db, workspace.id, { setupLog })
      const env = await workspaceEnv(db, workspace.id)
      await log(`setup: ${settings.setup}`)
      try {
        const { stdout, stderr } = await execFileAsync('zsh', ['-lc', settings.setup], {
          cwd: workspace.worktreePath,
          env: { ...process.env, ...env },
          maxBuffer: SETUP_MAX_BYTES,
          shell: false
        })
        await writeFile(setupLog, `${stdout}${stderr}`, 'utf8').catch(() => {})
      } catch (err) {
        const detail = err as { stdout?: string; stderr?: string }
        await writeFile(setupLog, `${detail.stdout ?? ''}${detail.stderr ?? ''}`, 'utf8').catch(() => {})
        throw new Error(`setup script failed: ${detail.stderr ?? String(err)}`)
      }
    }
    setWorkspaceState(db, workspace.id, 'ready')
    pushState(workspace.id, 'ready')
    await log('ready')
  } catch (err) {
    await log(`error: ${String(err)}`)
    setWorkspaceState(db, workspace.id, 'error')
    pushState(workspace.id, 'error')
    // A failure before the setup step has no setup log of its own; point the UI at the
    // init log instead of leaving the banner saying "unavailable".
    if (getWorkspaceOrThrow(db, workspace.id).setupLogPath === null) {
      setWorkspaceRuntime(db, workspace.id, { setupLog: initLog })
    }
  }
}

export async function removeWorkspace({ db, repoPath, workspace }: RemoveWorkspaceInput): Promise<void> {
  await removeWorktree(repoPath, workspace.worktreePath, workspace.branch)
  deleteWorkspace(db, workspace.id)
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed')
}
