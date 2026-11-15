import { handle, type Caller, type IpcDeps } from './registry'
import { attachmentFileName, writeAttachment } from '../context/materialize'
import { getWorkspaceOrThrow } from '../db/repos/workspaces'
import {
  createTerminal,
  destroyTerminal,
  listTerminals,
  resizeTerminal,
  setActiveTerminal,
  writeTerminal
} from '../pty'
import { runtimeFor } from '../runtime'
import { workspaceEnv } from '../workspace/bootstrap'

export function registerTerminalIpc(
  deps: IpcDeps,
  authorize?: (caller: Caller | undefined, workspaceId: string) => void
): void {
  handle('terminal:create', async ({ workspaceId }, caller) => {
    const workspace = getWorkspaceOrThrow(deps.db, workspaceId)
    const runtime = runtimeFor(workspace, deps.dataRoot)
    await runtime.ensureRunning()
    const env = await workspaceEnv(deps.db, workspaceId)
    authorize?.(caller, workspaceId)
    return createTerminal(workspace.worktreePath, env, runtime)
  })
  handle('terminal:list', ({ workspaceId }) =>
    listTerminals(getWorkspaceOrThrow(deps.db, workspaceId).worktreePath)
  )
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
