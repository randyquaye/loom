import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface UserRow {
  id: string
  email: string
}

/** Records a user the first time they are seen; a known id keeps the row it has. */
export function ensureUser(db: Database.Database, user: UserRow): void {
  db.prepare('INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)').run(
    user.id,
    user.email,
    Date.now()
  )
}

/** The user an email address belongs to, created the first time that address signs in. */
export function userForEmail(db: Database.Database, email: string): string {
  const known = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined
  if (known !== undefined) return known.id
  const id = randomUUID()
  ensureUser(db, { id, email })
  return id
}
