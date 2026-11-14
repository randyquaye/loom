import type { Migration } from './index'

export const m017: Migration = {
  name: '017_organization',
  up(db) {
    db.exec(`
      ALTER TABLE users ADD COLUMN google_subject TEXT;
      CREATE UNIQUE INDEX idx_users_google_subject ON users(google_subject);

      CREATE TABLE organization (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        name TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE org_members (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        kind TEXT NOT NULL CHECK (kind IN ('human', 'bot')),
        state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
        joined_at INTEGER NOT NULL,
        removed_at INTEGER,
        removed_by TEXT REFERENCES users(id),
        purge_started_at INTEGER,
        purged_at INTEGER
      );
      CREATE TABLE org_admin_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id TEXT NOT NULL REFERENCES users(id),
        action TEXT NOT NULL,
        subject TEXT,
        at INTEGER NOT NULL,
        detail TEXT
      );
      CREATE TABLE org_invites (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        used_at INTEGER,
        used_by TEXT REFERENCES users(id)
      );
      CREATE TABLE org_invite_attempts (
        code_challenge TEXT PRIMARY KEY,
        invite_id TEXT NOT NULL REFERENCES org_invites(id),
        expires_at INTEGER NOT NULL
      );
      ALTER TABLE auth_codes ADD COLUMN invite_id TEXT REFERENCES org_invites(id);
      ALTER TABLE auth_codes ADD COLUMN identity_token TEXT;
      ALTER TABLE auth_codes ADD COLUMN nonce TEXT;
    `)
  }
}
