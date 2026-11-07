import type Database from 'better-sqlite3'
import { m001 } from './001_init'
import { m002 } from './002_cascade'
import { m003 } from './003_workspace_runtime'
import { m004 } from './004_project_prompts'
import { m005 } from './005_diff_comments'
import { m006 } from './006_workspace_auto_named'

export interface Migration {
  name: string
  up(db: Database.Database): void
}

const migrations: Migration[] = [m001, m002, m003, m004, m005, m006]

export function migrate(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)')
  const done = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>).map((r) => r.name)
  )
  const record = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
  for (const migration of migrations) {
    if (done.has(migration.name)) continue
    db.transaction(() => {
      migration.up(db)
      record.run(migration.name, Date.now())
    })()
  }
}
