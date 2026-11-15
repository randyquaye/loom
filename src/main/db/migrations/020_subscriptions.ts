import type { Migration } from './index'

export const m020: Migration = {
  name: '020_subscriptions',
  up(db) {
    db.exec(`
      CREATE TABLE subscription_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        label TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        state TEXT NOT NULL DEFAULT 'disconnected'
          CHECK (state IN ('disconnected', 'ready', 'rate_limited', 'auth_failed')),
        revision INTEGER NOT NULL DEFAULT 1,
        retry_at INTEGER,
        provider_reset_at INTEGER,
        last_used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE subscription_identities (
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        identity TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES subscription_accounts(id),
        PRIMARY KEY (provider, identity)
      );
      CREATE TABLE bot_subscription_grants (
        bot_id TEXT NOT NULL REFERENCES bots(user_id),
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        PRIMARY KEY (bot_id, provider)
      );
      CREATE TABLE subscription_bindings (
        workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        bot_id TEXT NOT NULL REFERENCES bots(user_id),
        account_id TEXT NOT NULL REFERENCES subscription_accounts(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, provider)
      );
      CREATE INDEX idx_subscription_bindings_account ON subscription_bindings(account_id);
    `)
  }
}
