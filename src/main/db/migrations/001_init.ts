import type { Migration } from './index'

export const m001: Migration = {
  name: '001_init',
  up(db) {
    db.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        remote_url TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project_id, name)
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        backend TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        closed_at INTEGER,
        forked_from TEXT,
        provider_session_id TEXT
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        UNIQUE(session_id, seq)
      );

      CREATE TABLE events_rendered (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE events_fts USING fts5(text, content='events_rendered', content_rowid='id');

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

      CREATE TABLE terminals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_workspaces_project ON workspaces(project_id);
      CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
      CREATE INDEX idx_events_session ON events(session_id, seq);
      CREATE INDEX idx_rendered_session ON events_rendered(session_id);
    `)
  }
}
