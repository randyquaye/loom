import type Database from 'better-sqlite3'
import type { HistoryHit } from '../../shared/ipc-contract'
import { handle, type IpcDeps } from './registry'

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

/** `ownerId` narrows the search to one user's workspaces, as a runner must; omitted, all of them. */
export function searchHistory(
  db: Database.Database,
  query: string,
  projectId: string | null = null,
  ownerId?: string,
  visibleWorkspaceIds: readonly string[] = []
): HistoryHit[] {
  const scope: string[] = []
  const scopeParams: string[] = []
  if (projectId !== null) {
    scope.push('w.project_id = ?')
    scopeParams.push(projectId)
  }
  if (ownerId !== undefined) {
    scope.push(`(w.owner_id = ? OR (
      w.id IN (SELECT value FROM json_each(?)) AND EXISTS (
        SELECT 1 FROM org_members m WHERE m.user_id = w.owner_id AND m.kind = 'bot' AND m.state = 'active'
      )
    ))`)
    scopeParams.push(ownerId, JSON.stringify(visibleWorkspaceIds))
  }
  const trimmed = query.trim()
  if (trimmed === '') {
    const where = scope.length === 0 ? '' : ` WHERE ${scope.join(' AND ')}`
    const sql = `${RECENT_SQL}${where} ORDER BY s.created_at DESC LIMIT 50`
    return db.prepare(sql).all(...scopeParams) as HistoryHit[]
  }
  const sql = `${SEARCH_SQL}${scope.map((clause) => ` AND ${clause}`).join('')} ORDER BY rank LIMIT 50`
  return db.prepare(sql).all(asPhrase(trimmed), ...scopeParams) as HistoryHit[]
}

export function registerHistoryIpc(deps: IpcDeps): void {
  handle('history:search', ({ query, projectId }) => searchHistory(deps.db, query, projectId))
}
