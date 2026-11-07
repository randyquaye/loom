import type Database from 'better-sqlite3'
import type { HistoryHit } from '../../shared/ipc-contract'
import { handle, type IpcDeps } from './index'

const SEARCH_SQL = `
  SELECT s.id AS sessionId, s.workspace_id AS workspaceId, w.project_id AS projectId,
         p.name AS projectLabel, s.title AS sessionTitle,
         snippet(events_fts, 0, '>>', '<<', '…', 12) AS snippet,
         s.created_at AS createdAt
  FROM events_fts
  JOIN events_rendered ON events_rendered.id = events_fts.rowid
  JOIN sessions s ON s.id = events_rendered.session_id
  JOIN workspaces w ON w.id = s.workspace_id
  JOIN projects p ON p.id = w.project_id
  WHERE events_fts MATCH ?`

const RECENT_SQL = `
  SELECT s.id AS sessionId, s.workspace_id AS workspaceId, w.project_id AS projectId,
         p.name AS projectLabel, s.title AS sessionTitle, '' AS snippet,
         s.created_at AS createdAt
  FROM sessions s
  JOIN workspaces w ON w.id = s.workspace_id
  JOIN projects p ON p.id = w.project_id`

/** User text is quoted as a single FTS phrase so operators cannot inject syntax. */
function asPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`
}

export function searchHistory(db: Database.Database, query: string, projectId: string | null): HistoryHit[] {
  const trimmed = query.trim()
  if (trimmed === '') {
    const sql = `${RECENT_SQL}${projectId === null ? '' : ' WHERE w.project_id = ?'} ORDER BY s.created_at DESC LIMIT 50`
    const rows =
      projectId === null
        ? (db.prepare(sql).all() as HistoryHit[])
        : (db.prepare(sql).all(projectId) as HistoryHit[])
    return rows
  }
  const sql = `${SEARCH_SQL}${projectId === null ? '' : ' AND w.project_id = ?'} ORDER BY rank LIMIT 50`
  const rows =
    projectId === null
      ? (db.prepare(sql).all(asPhrase(trimmed)) as HistoryHit[])
      : (db.prepare(sql).all(asPhrase(trimmed), projectId) as HistoryHit[])
  return rows
}

export function registerHistoryIpc(deps: IpcDeps): void {
  handle('history:search', ({ query, projectId }) => searchHistory(deps.db, query, projectId))
}
