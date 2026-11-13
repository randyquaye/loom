import type Database from 'better-sqlite3'
import { m001 } from './001_init'
import { m002 } from './002_cascade'
import { m003 } from './003_workspace_runtime'
import { m004 } from './004_project_prompts'
import { m005 } from './005_diff_comments'
import { m006 } from './006_workspace_auto_named'
import { m007 } from './007_session_instructions'
import { m008 } from './008_session_read'
import { m009 } from './009_workspace_placement'
import { m010 } from './010_session_durability'
import { m011 } from './011_owners'
import { m012 } from './012_sign_in'
import { m013 } from './013_pending_deliveries'
import { m014 } from './014_workspace_power'

export interface Migration {
  name: string
  up(db: Database.Database): void
}

const migrations: Migration[] = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
  m012,
  m013,
  m014
]

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
