import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { renderEventForSearch, type AgentEvent } from '../src/shared/events'

describe('db', () => {
  it('creates every table on first open', () => {
    const db = openDb(':memory:')
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(tables).toEqual(
      expect.arrayContaining([
        'projects',
        'workspaces',
        'sessions',
        'events',
        'events_rendered',
        'events_fts',
        'terminals',
        '_migrations'
      ])
    )
  })

  it('is idempotent across re-open of the same file', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'loom-db-')), 'loom.db')
    openDb(file).close()
    const second = openDb(file)
    const rows = second.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>
    expect(rows.map((r) => r.name)).toEqual([
      '001_init',
      '002_cascade_search_and_terminals',
      '003_workspace_runtime',
      '004_project_prompts',
      '005_diff_comments',
      '006_workspace_auto_named'
    ])
    second.close()
  })

  it('cascades search text when a session is deleted', () => {
    const db = openDb(':memory:')
    db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
      'p1',
      'demo',
      '/tmp/demo',
      1
    )
    db.prepare(
      'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('w1', 'p1', 'ws', 'loom/ws', '/tmp/wt', 1)
    db.prepare(
      'INSERT INTO sessions (id, workspace_id, backend, model, effort, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('s1', 'w1', 'qwen', 'qwen3-max', 'medium', 'demo session', 1)
    db.prepare('INSERT INTO events_rendered (session_id, text) VALUES (?, ?)').run('s1', 'secret phrase')
    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1')
    const left = db.prepare('SELECT COUNT(*) AS n FROM events_rendered').get() as { n: number }
    expect(left.n).toBe(0)
  })

  it('indexes event text for full-text search through triggers', () => {
    const db = openDb(':memory:')
    db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
      'p1',
      'demo',
      '/tmp/demo',
      1
    )
    db.prepare(
      'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('w1', 'p1', 'ws', 'loom/ws', '/tmp/wt', 1)
    db.prepare(
      'INSERT INTO sessions (id, workspace_id, backend, model, effort, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('s1', 'w1', 'qwen', 'qwen3-max', 'medium', 'demo session', 1)

    const event: AgentEvent = { type: 'text.done', turnId: 't1', text: 'the quick brown fox' }
    db.prepare('INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)').run(
      's1',
      1,
      1,
      event.type,
      JSON.stringify(event)
    )
    db.prepare('INSERT INTO events_rendered (session_id, text) VALUES (?, ?)').run(
      's1',
      renderEventForSearch(event)
    )

    const hits = db
      .prepare(
        `SELECT events_rendered.session_id AS session_id
         FROM events_fts JOIN events_rendered ON events_rendered.id = events_fts.rowid
         WHERE events_fts MATCH ?`
      )
      .all('quick') as Array<{ session_id: string }>
    expect(hits.map((h) => h.session_id)).toEqual(['s1'])
  })
})
