import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { addComment, listComments, removeComment, rewriteCommentsFile } from '../src/main/db/repos/comments'

function dbWithWorkspace(worktreePath: string) {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
    'p1',
    'demo',
    '/tmp/demo',
    1
  )
  db.prepare(
    'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('w1', 'p1', 'ws', 'loom/ws', worktreePath, 1)
  return db
}

describe('diff comments', () => {
  it('lists by path and line, and mirrors to .context/attachments/comments.md', async () => {
    const wt = await mkdtemp(path.join(tmpdir(), 'loom-comments-'))
    const db = dbWithWorkspace(wt)

    const late = addComment(db, { workspaceId: 'w1', path: 'src/a.ts', line: 12, body: 'off by one' })
    addComment(db, { workspaceId: 'w1', path: 'src/a.ts', line: 4, body: 'naming' })
    await rewriteCommentsFile(wt, listComments(db, 'w1'))

    const mirror = await readFile(path.join(wt, '.context', 'attachments', 'comments.md'), 'utf8')
    expect(mirror).toContain('## src/a.ts')
    expect(mirror).toContain('- line 4: naming')
    expect(mirror).toContain('- line 12: off by one')
    expect(listComments(db, 'w1').map((row) => row.line)).toEqual([4, 12])

    expect(removeComment(db, late.id)).toBe('w1')
    expect(listComments(db, 'w1')).toHaveLength(1)
    expect(removeComment(db, 'missing')).toBeNull()
  })

  it('writes an explicit empty mirror when no comments remain', async () => {
    const wt = await mkdtemp(path.join(tmpdir(), 'loom-comments-empty-'))
    const db = dbWithWorkspace(wt)

    await rewriteCommentsFile(wt, listComments(db, 'w1'))

    const mirror = await readFile(path.join(wt, '.context', 'attachments', 'comments.md'), 'utf8')
    expect(mirror).toContain('(none)')
  })
})
