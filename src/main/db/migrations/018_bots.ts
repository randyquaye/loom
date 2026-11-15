import type { Migration } from './index'

export const m018: Migration = {
  name: '018_bots',
  up(db) {
    db.exec(`
      CREATE TABLE bots (
        user_id TEXT PRIMARY KEY REFERENCES org_members(user_id),
        slug TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        config TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE bot_grants (
        bot_id TEXT NOT NULL REFERENCES bots(user_id),
        user_id TEXT NOT NULL REFERENCES org_members(user_id),
        access TEXT NOT NULL CHECK (access IN ('view', 'control')),
        PRIMARY KEY (bot_id, user_id)
      );
      CREATE TABLE bot_session_reads (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id),
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, user_id)
      );
      CREATE TABLE bot_invocations (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(user_id),
        requester_id TEXT NOT NULL REFERENCES users(id),
        request_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        config TEXT NOT NULL,
        repository TEXT NOT NULL,
        prompt TEXT NOT NULL,
        workspace_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL UNIQUE,
        message_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('preparing', 'ready', 'failed', 'interrupted')),
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (bot_id, requester_id, request_key)
      );
      CREATE INDEX idx_bot_invocations_bot_created ON bot_invocations(bot_id, created_at);
    `)
  }
}
