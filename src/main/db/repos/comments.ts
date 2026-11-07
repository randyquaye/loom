import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { CONTEXT_DIR } from '../../../shared/brand'
import type { CommentRow } from '../../../shared/ipc-contract'

/** Stable attachment name: the agent-facing mirror of the diff comments. */
export const COMMENTS_FILE = 'comments.md'

interface DbCommentRow {
  id: string
  workspace_id: string
  path: string
  line: number
  body: string
  created_at: number
}

const COLUMNS = 'id, workspace_id, path, line, body, created_at'

function toCommentRow(row: DbCommentRow): CommentRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    line: row.line,
    body: row.body,
    createdAt: row.created_at
  }
}

export function listComments(db: Database.Database, workspaceId: string): CommentRow[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM diff_comments WHERE workspace_id = ? ORDER BY path, line, created_at`)
    .all(workspaceId) as DbCommentRow[]
  return rows.map(toCommentRow)
}

export function addComment(
  db: Database.Database,
  input: { workspaceId: string; path: string; line: number; body: string }
): CommentRow {
  const row: CommentRow = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    path: input.path,
    line: input.line,
    body: input.body,
    createdAt: Date.now()
  }
  db.prepare(
    `INSERT INTO diff_comments (id, workspace_id, path, line, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.workspaceId, row.path, row.line, row.body, row.createdAt)
  return row
}

/** Deletes one comment; returns its workspace so callers can refresh the mirror file. */
export function removeComment(db: Database.Database, id: string): string | null {
  const row = db.prepare('SELECT workspace_id FROM diff_comments WHERE id = ?').get(id) as
    { workspace_id: string } | undefined
  if (row === undefined) return null
  db.prepare('DELETE FROM diff_comments WHERE id = ?').run(id)
  return row.workspace_id
}

/**
 * Rewrites .context/attachments/comments.md as the agent-facing mirror of the
 * comment list; the autolink wrapper already points agents at attachments/.
 */
export async function rewriteCommentsFile(worktreePath: string, comments: CommentRow[]): Promise<void> {
  const dir = path.join(worktreePath, CONTEXT_DIR, 'attachments')
  await mkdir(dir, { recursive: true })
  const lines = [
    '# Review comments',
    '',
    'Left on worktree diffs in Loom. Address or dismiss each; they persist until removed there.'
  ]
  if (comments.length === 0) {
    lines.push('', '(none)')
  } else {
    for (const comment of comments) {
      lines.push('', `## ${comment.path}`, `- line ${comment.line}: ${comment.body}`)
    }
  }
  await writeFile(path.join(dir, COMMENTS_FILE), `${lines.join('\n')}\n`, 'utf8')
}
