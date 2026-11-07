import { describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { searchHistory } from '../src/main/ipc/history'
import { renderEventForSearch, type AgentEvent } from '../src/shared/events'

function seed() {
  const db = openDb(':memory:')
  db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
    'p1',
    'alpha',
    '/tmp/alpha',
    1
  )
  db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
    'p2',
    'beta',
    '/tmp/beta',
    2
  )
  db.prepare(
    'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('w1', 'p1', 'ws1', 'loom/ws1', '/tmp/w1', 1)
  db.prepare(
    'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('w2', 'p2', 'ws2', 'loom/ws2', '/tmp/w2', 2)
  db.prepare(
    'INSERT INTO sessions (id, workspace_id, backend, model, effort, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('s1', 'w1', 'qwen', 'qwen3-max', 'medium', 'rate limit work', 1)
  db.prepare(
    'INSERT INTO sessions (id, workspace_id, backend, model, effort, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run('s2', 'w2', 'gemini', 'gemini-2.5-pro', 'high', 'unrelated chat', 2)
  const event: AgentEvent = { type: 'text.done', turnId: 't', text: 'discussing the crimson rate limit' }
  db.prepare('INSERT INTO events_rendered (session_id, text) VALUES (?, ?)').run(
    's1',
    renderEventForSearch(event)
  )
  return db
}

describe('searchHistory', () => {
  it('finds transcript phrases across sessions', () => {
    const db = seed()
    const hits = searchHistory(db, 'crimson', null)
    expect(hits.map((h) => h.sessionId)).toEqual(['s1'])
    expect(hits[0]?.projectLabel).toBe('alpha')
    expect(hits[0]?.snippet).toContain('crimson')
  })

  it('filters by project', () => {
    const db = seed()
    expect(searchHistory(db, 'crimson', 'p2')).toEqual([])
    expect(searchHistory(db, 'crimson', 'p1')).toHaveLength(1)
  })

  it('returns recents for an empty query, newest first', () => {
    const db = seed()
    const recents = searchHistory(db, '', null)
    expect(recents.map((h) => h.sessionId)).toEqual(['s2', 's1'])
  })

  it('treats FTS operators as literal text', () => {
    const db = seed()
    expect(searchHistory(db, 'crimson" OR s2:* --', null)).toEqual([])
  })
})
