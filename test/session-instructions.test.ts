import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { sessionInstructions } from '../src/main/sessions/instructions'

const databases: Database.Database[] = []
const roots: string[] = []

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(file = ':memory:') {
  const db = openDb(file)
  databases.push(db)
  db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
    'p',
    'project',
    '/unused',
    1
  )
  db.prepare(
    'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('w', 'p', 'workspace', 'loom/workspace', '/unused', 1)
  return db
}

function insert(db: Database.Database, id: string, backend: string, snapshot: string | null) {
  db.prepare(
    'INSERT INTO sessions (id, workspace_id, backend, model, effort, title, created_at, instruction_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'w', backend, 'model', 'medium', id, 1, snapshot)
}

describe('session instruction visibility', () => {
  it('shows the exact saved instructions after reopening the database', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'loom-instruction-info-'))
    roots.push(root)
    const file = path.join(root, 'loom.db')
    const first = fixture(file)
    const text = '\n# Saved instructions\r\nKeep spacing and π exactly.\n\n'
    insert(first, 'saved', 'codex', text)
    first.close()
    const reopened = openDb(file)
    databases.push(reopened)

    expect(sessionInstructions(reopened, 'saved')).toEqual({
      status: 'saved',
      text,
      repositoryMode: 'native'
    })
  })

  it('distinguishes pending from legacy without reconstructing or updating either snapshot', () => {
    const db = fixture()
    insert(db, 'pending', 'qwen', '')
    insert(db, 'legacy', 'claude', null)

    expect(sessionInstructions(db, 'pending')).toEqual({
      status: 'pending',
      text: null,
      repositoryMode: 'root-files'
    })
    expect(sessionInstructions(db, 'legacy')).toEqual({
      status: 'legacy',
      text: null,
      repositoryMode: 'native'
    })
    expect(db.prepare('SELECT id, instruction_snapshot FROM sessions ORDER BY id').all()).toEqual([
      { id: 'legacy', instruction_snapshot: null },
      { id: 'pending', instruction_snapshot: '' }
    ])
  })

  it.each([
    ['codex', 'native'],
    ['claude', 'native'],
    ['gemini', 'root-files'],
    ['qwen', 'root-files']
  ] as const)(
    'reports %s repository handling without claiming files were loaded',
    (backend, repositoryMode) => {
      const db = fixture()
      insert(db, 'session', backend, 'saved text')
      expect(sessionInstructions(db, 'session').repositoryMode).toBe(repositoryMode)
    }
  )

  it('rejects unknown sessions instead of inventing an empty instruction state', () => {
    expect(() => sessionInstructions(fixture(), 'missing')).toThrow('unknown session missing')
  })
})
