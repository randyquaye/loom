import { handle, type IpcDeps } from './index'
import { attachmentFileName, writeAttachment } from '../context/materialize'
import { createTerminal, destroyTerminal, resizeTerminal, setActiveTerminal, writeTerminal } from '../pty'
import { workspaceEnv } from '../workspace/bootstrap'

export function registerTerminalIpc(deps: IpcDeps): void {
  handle('terminal:create', async ({ workspaceId }) => {
    const row = deps.db.prepare('SELECT worktree_path FROM workspaces WHERE id = ?').get(workspaceId) as
      { worktree_path: string } | undefined
    if (row === undefined) throw new Error(`unknown workspace ${workspaceId}`)
    return createTerminal(row.worktree_path, await workspaceEnv(deps.db, workspaceId))
  })
  handle('terminal:attach', ({ workspaceId, text }) => {
    const row = deps.db.prepare('SELECT worktree_path FROM workspaces WHERE id = ?').get(workspaceId) as
      { worktree_path: string } | undefined
    if (row === undefined) throw new Error(`unknown workspace ${workspaceId}`)
    return writeAttachment(row.worktree_path, attachmentFileName('terminal', '', Date.now()), text)
  })
  handle('terminal:write', ({ id, data }) => writeTerminal(id, data))
  handle('terminal:resize', ({ id, cols, rows }) => resizeTerminal(id, cols, rows))
  handle('terminal:destroy', ({ id }) => destroyTerminal(id))
  handle('terminal:setActive', ({ id }) => setActiveTerminal(id))
}
