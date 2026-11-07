import type { Migration } from './index'

/**
 * events_rendered and terminals lacked ON DELETE CASCADE, so deleted sessions
 * left transcript text (possibly containing echoed secrets) searchable forever.
 * SQLite cannot add a foreign key in place, so both tables are rebuilt and the
 * FTS sync triggers re-created against the renamed tables.
 */
export const m002: Migration = {
  name: '002_cascade_search_and_terminals',
  up(db) {
    db.exec(`
      DELETE FROM events_rendered WHERE session_id NOT IN (SELECT id FROM sessions);
      DELETE FROM terminals WHERE workspace_id NOT IN (SELECT id FROM workspaces);

      CREATE TABLE events_rendered_new (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        text TEXT NOT NULL
      );
      INSERT INTO events_rendered_new (id, session_id, text)
        SELECT id, session_id, text FROM events_rendered;
      DROP TABLE events_rendered;
      ALTER TABLE events_rendered_new RENAME TO events_rendered;
      CREATE INDEX idx_rendered_session ON events_rendered(session_id);

      CREATE TABLE terminals_new (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO terminals_new (id, workspace_id, cwd, created_at)
        SELECT id, workspace_id, cwd, created_at FROM terminals;
      DROP TABLE terminals;
      ALTER TABLE terminals_new RENAME TO terminals;

      CREATE TRIGGER events_rendered_ai AFTER INSERT ON events_rendered BEGIN
        INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER events_rendered_ad AFTER DELETE ON events_rendered BEGIN
        INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER events_rendered_au AFTER UPDATE ON events_rendered BEGIN
        INSERT INTO events_fts(events_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `)
  }
}
