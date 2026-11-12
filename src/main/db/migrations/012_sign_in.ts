import type { Migration } from './index'

export const m012: Migration = {
  name: '012_sign_in',
  up(db) {
    db.exec(`
      -- One row per time a desktop signed in. Every code and token descends from one, and
      -- revoking it ends them all at once.
      CREATE TABLE sign_ins (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX idx_sign_ins_user ON sign_ins(user_id);

      CREATE TABLE auth_codes (
        code_hash TEXT PRIMARY KEY,
        sign_in_id TEXT NOT NULL REFERENCES sign_ins(id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      );

      CREATE TABLE auth_tokens (
        id TEXT PRIMARY KEY,
        sign_in_id TEXT NOT NULL REFERENCES sign_ins(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX idx_auth_tokens_sign_in ON auth_tokens(sign_in_id);
    `)
  }
}
