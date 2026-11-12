import type Database from 'better-sqlite3'
import type {
  WorkspaceCheckout,
  WorkspaceRow,
  WorkspaceRuntimeKind,
  WorkspaceState
} from '../../../shared/ipc-contract'

export interface DbWorkspaceRow {
  id: string
  project_id: string
  name: string
  branch: string
  worktree_path: string
  created_at: number
  archived: number
  state: string
  port: number | null
  initialization_files_copied: number | null
  initialization_log_path: string | null
  setup_log_path: string | null
  checkout: string
  runtime: string
  owner_id: string | null
}

const COLUMNS =
  'id, project_id, name, branch, worktree_path, created_at, archived, state, port, initialization_files_copied, initialization_log_path, setup_log_path, checkout, runtime, owner_id'

export function toWorkspaceRow(row: DbWorkspaceRow): WorkspaceRow {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    branch: row.branch,
    worktreePath: row.worktree_path,
    createdAt: row.created_at,
    archived: row.archived !== 0,
    state: row.state as WorkspaceState,
    port: row.port,
    initializationFilesCopied: row.initialization_files_copied,
    setupLogPath: row.setup_log_path,
    checkout: row.checkout as WorkspaceCheckout,
    runtime: row.runtime as WorkspaceRuntimeKind,
    ownerId: row.owner_id
  }
}

export function listWorkspaces(db: Database.Database, projectId: string): WorkspaceRow[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM workspaces WHERE project_id = ? ORDER BY created_at ASC, name ASC`)
    .all(projectId) as DbWorkspaceRow[]
  return rows.map(toWorkspaceRow)
}

export function getWorkspace(db: Database.Database, id: string): WorkspaceRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM workspaces WHERE id = ?`).get(id) as
    DbWorkspaceRow | undefined
  return row === undefined ? null : toWorkspaceRow(row)
}

export function countWorkspaces(db: Database.Database, projectId: string, ownerId: string | null): number {
  // Archived workspaces are parked, not active: they must not consume a slot in
  // the per-project cap, matching what the sidebar shows and enables. The cap is each
  // owner's own; `IS` also matches the ownerless workspaces of this Mac.
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM workspaces WHERE project_id = ? AND archived = 0 AND owner_id IS ?')
    .get(projectId, ownerId) as { n: number }
  return row.n
}

/**
 * Branch uniqueness is a property of the repository, not the project row: two
 * project rows may point at the same checkout, so the lookup is scoped by repo path.
 */
export function repoBranchTaken(db: Database.Database, repoPath: string, branch: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM workspaces
       JOIN projects ON projects.id = workspaces.project_id
       WHERE projects.repo_path = ? AND workspaces.branch = ?
       LIMIT 1`
    )
    .get(repoPath, branch) as { hit: number } | undefined
  return row !== undefined
}

export function insertWorkspace(db: Database.Database, workspace: WorkspaceRow): void {
  db.prepare(
    `INSERT INTO workspaces
     (id, project_id, name, branch, worktree_path, created_at, archived, state, port,
      initialization_files_copied, setup_log_path, checkout, runtime, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    workspace.id,
    workspace.projectId,
    workspace.name,
    workspace.branch,
    workspace.worktreePath,
    workspace.createdAt,
    workspace.archived ? 1 : 0,
    workspace.state,
    workspace.port,
    workspace.initializationFilesCopied,
    workspace.setupLogPath,
    workspace.checkout,
    workspace.runtime,
    workspace.ownerId
  )
}

export function setWorkspaceState(db: Database.Database, id: string, state: WorkspaceState): void {
  db.prepare('UPDATE workspaces SET state = ? WHERE id = ?').run(state, id)
}

/**
 * Model-computed display rename: applies only while the name is still the auto-derived one,
 * and exactly once — the flag clears with the rename, so a later manual rename is safe.
 * UNIQUE(project_id, name) collisions retry with a numeric suffix before giving up.
 */
export function renameWorkspaceIfAuto(db: Database.Database, id: string, name: string): boolean {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = attempt === 0 ? name : `${name}-${attempt + 1}`
    const info = db
      .prepare('UPDATE workspaces SET name = ?, auto_named = 0 WHERE id = ? AND auto_named = 1')
      .run(candidate, id)
    if (info.changes > 0) return true
    const row = db.prepare('SELECT auto_named FROM workspaces WHERE id = ?').get(id) as
      { auto_named: number } | undefined
    if (row === undefined || row.auto_named !== 1) return false
  }
  return false
}

export function setWorkspaceRuntime(
  db: Database.Database,
  id: string,
  runtime: { copied?: number | null; initLog?: string | null; setupLog?: string | null }
): void {
  db.prepare(
    `UPDATE workspaces SET
       initialization_files_copied = COALESCE(?, initialization_files_copied),
       initialization_log_path = COALESCE(?, initialization_log_path),
       setup_log_path = COALESCE(?, setup_log_path)
     WHERE id = ?`
  ).run(runtime.copied ?? null, runtime.initLog ?? null, runtime.setupLog ?? null, id)
}

/** Ten-port blocks per workspace, first free wins; Conductor allocates the same way. */
export function allocatePort(db: Database.Database): number {
  const used = new Set(
    (db.prepare('SELECT port FROM workspaces WHERE port IS NOT NULL').all() as Array<{ port: number }>).map(
      (row) => row.port
    )
  )
  for (let port = 4100; port <= 9990; port += 10) {
    if (!used.has(port)) return port
  }
  throw new Error('workspace port range exhausted')
}

export function deleteWorkspace(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
}

export function setWorkspaceArchived(db: Database.Database, id: string, archived: boolean): void {
  db.prepare('UPDATE workspaces SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
}

export class WorkspaceNotFoundError extends Error {
  readonly code = 'WORKSPACE_NOT_FOUND'

  constructor(id: string) {
    super(`WORKSPACE_NOT_FOUND: no workspace with id ${id}`)
    this.name = 'WorkspaceNotFoundError'
  }
}

export function getWorkspaceOrThrow(db: Database.Database, id: string): WorkspaceRow {
  const workspace = getWorkspace(db, id)
  if (workspace === null) throw new WorkspaceNotFoundError(id)
  return workspace
}
