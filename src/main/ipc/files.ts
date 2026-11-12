import { readFilePreview } from '../fs/preview'
import { readFileJailed } from '../fs/read'
import { listDir } from '../fs/tree'
import { makeWorktreeResolver } from '../fs/workspace-root'
import { handle, type IpcDeps } from './registry'

export function registerFilesIpc(deps: IpcDeps): void {
  const worktreeOf = makeWorktreeResolver(deps.db)

  handle('files:tree', ({ workspaceId }) => listDir(worktreeOf(workspaceId), ''))

  handle('files:listDir', ({ workspaceId, path }) => listDir(worktreeOf(workspaceId), path))

  handle('files:read', ({ workspaceId, path }) => readFileJailed(worktreeOf(workspaceId), path))

  handle('files:preview', ({ workspaceId, path }) => readFilePreview(worktreeOf(workspaceId), path))
}
