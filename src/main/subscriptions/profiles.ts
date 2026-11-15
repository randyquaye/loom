import path from 'node:path'
import type Database from 'better-sqlite3'
import type { WorkspaceRow } from '../../shared/ipc-contract'

/** Account affinity gives each bot workspace its own nonsecret CLI profile. */
export function botWorkspaceProfileName(workspaceId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) throw new Error('Invalid bot workspace identity')
  return `bot-workspace-${workspaceId}`
}

/** Historical personal ids remain valid; bot profiles must never share their home. */
export function assertBotProfileAvailable(db: Database.Database, workspaceId: string): void {
  const name = botWorkspaceProfileName(workspaceId)
  if (db.prepare('SELECT 1 FROM users WHERE id=?').get(name) !== undefined)
    throw new Error('The reserved bot workspace profile collides with an existing user home')
}

/** Validate before stopping or deleting anything; removed bot members retain their kind. */
export function botWorkspaceProfileFolders(
  db: Database.Database,
  workspace: Pick<WorkspaceRow, 'id' | 'ownerId'>,
  dataRoot: string | undefined
): string[] {
  if (workspace.ownerId === null) return []
  const member = db.prepare('SELECT kind FROM org_members WHERE user_id=?').get(workspace.ownerId) as
    { kind: string } | undefined
  if (member?.kind !== 'bot') return []
  if (dataRoot === undefined) throw new Error('Removing a bot workspace profile requires the data root')
  assertBotProfileAvailable(db, workspace.id)
  const name = botWorkspaceProfileName(workspace.id)
  // login-files-view is a read-only bind view of login-files, emptied by deleting its source.
  return [path.join(dataRoot, 'homes', name), path.join(dataRoot, 'login-files', name)]
}
