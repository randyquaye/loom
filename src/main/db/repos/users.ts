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

/** Google subjects are durable identities; email is mutable contact information. */
export function userForGoogle(db: Database.Database, person: { subject: string; email: string }): string {
  if (person.subject === '') throw new Error('Google supplied no account identity')
  const email = person.email.trim().toLowerCase()
  return db.transaction(() => {
    const known = db.prepare('SELECT id FROM users WHERE google_subject = ?').get(person.subject) as
      { id: string } | undefined
    const addressed = db
      .prepare('SELECT id, google_subject FROM users WHERE email = ? COLLATE NOCASE')
      .get(email) as { id: string; google_subject: string | null } | undefined
    if (addressed !== undefined && addressed.id !== known?.id && addressed.google_subject !== null) {
      throw new Error('This address belongs to a different Google account; contact an organization owner')
    }
    if (known !== undefined) {
      // An unbound legacy row must not be silently merged with an existing Google identity.
      if (addressed !== undefined && addressed.id !== known.id) {
        throw new Error('This address belongs to a different Google account; contact an organization owner')
      }
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, known.id)
      return known.id
    }
    const id = addressed?.id ?? randomUUID()
    if (addressed === undefined) ensureUser(db, { id, email })
    db.prepare('UPDATE users SET google_subject = ?, email = ? WHERE id = ?').run(person.subject, email, id)
    return id
  })()
}
