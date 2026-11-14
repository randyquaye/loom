import type { Migration } from './index'

export const m016: Migration = {
  name: '016_agent_modes',
  up(db) {
    // Null leaves an agent to its own CLI settings, as on this Mac. A runner's workspaces,
    // the ones with an owner, take the defaults if they were made before modes existed.
    db.exec(`
      ALTER TABLE workspaces ADD COLUMN claude_mode TEXT;
      ALTER TABLE workspaces ADD COLUMN codex_mode TEXT;
      UPDATE workspaces SET claude_mode = 'auto', codex_mode = 'sandbox' WHERE owner_id IS NOT NULL;
    `)
  }
}
