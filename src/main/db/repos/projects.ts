import type Database from 'better-sqlite3'
import type { ProjectPromptsInput, ProjectRow } from '../../../shared/ipc-contract'

export interface DbProjectRow {
  id: string
  name: string
  repo_path: string
  remote_url: string | null
  created_at: number
  custom_prompt_general: string | null
  custom_prompt_code_review: string | null
  custom_prompt_fix_errors: string | null
}

const COLUMNS =
  'id, name, repo_path, remote_url, created_at, custom_prompt_general, custom_prompt_code_review, custom_prompt_fix_errors'

export function toProjectRow(row: DbProjectRow): ProjectRow {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repo_path,
    remoteUrl: row.remote_url,
    createdAt: row.created_at,
    customPromptGeneral: row.custom_prompt_general,
    customPromptCodeReview: row.custom_prompt_code_review,
    customPromptFixErrors: row.custom_prompt_fix_errors
  }
}

export function listProjects(db: Database.Database): ProjectRow[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM projects ORDER BY created_at ASC, name ASC`)
    .all() as DbProjectRow[]
  return rows.map(toProjectRow)
}

export function getProject(db: Database.Database, id: string): ProjectRow | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ?`).get(id) as DbProjectRow | undefined
  return row === undefined ? null : toProjectRow(row)
}

export function insertProject(db: Database.Database, project: ProjectRow): void {
  db.prepare(
    `INSERT INTO projects
     (id, name, repo_path, remote_url, created_at,
      custom_prompt_general, custom_prompt_code_review, custom_prompt_fix_errors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    project.id,
    project.name,
    project.repoPath,
    project.remoteUrl,
    project.createdAt,
    project.customPromptGeneral,
    project.customPromptCodeReview,
    project.customPromptFixErrors
  )
}

export function setProjectRemoteUrl(db: Database.Database, id: string, remoteUrl: string | null): void {
  db.prepare('UPDATE projects SET remote_url = ? WHERE id = ?').run(remoteUrl, id)
}

export function setProjectPrompts(db: Database.Database, input: ProjectPromptsInput): void {
  const blankToNull = (value: string | null): string | null =>
    value === null || value.trim() === '' ? null : value
  db.prepare(
    `UPDATE projects SET
       custom_prompt_general = ?,
       custom_prompt_code_review = ?,
       custom_prompt_fix_errors = ?
     WHERE id = ?`
  ).run(
    blankToNull(input.general),
    blankToNull(input.codeReview),
    blankToNull(input.fixErrors),
    input.projectId
  )
}

export function deleteProject(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}

/** Two project rows may adopt the same checkout; cleanup must not delete a shared repo. */
export function repoPathTaken(db: Database.Database, repoPath: string): boolean {
  const row = db.prepare('SELECT 1 AS hit FROM projects WHERE repo_path = ? LIMIT 1').get(repoPath) as
    { hit: number } | undefined
  return row !== undefined
}

export class ProjectNotFoundError extends Error {
  readonly code = 'PROJECT_NOT_FOUND'

  constructor(id: string) {
    super(`PROJECT_NOT_FOUND: no project with id ${id}`)
    this.name = 'ProjectNotFoundError'
  }
}

export function getProjectOrThrow(db: Database.Database, id: string): ProjectRow {
  const project = getProject(db, id)
  if (project === null) throw new ProjectNotFoundError(id)
  return project
}
