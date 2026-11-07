import { dialog } from 'electron'
import { readFileJailed } from '../fs/read'
import { listDir } from '../fs/tree'
import { makeWorktreeResolver } from '../fs/workspace-root'
import { handle, type IpcDeps } from './index'

export function registerFilesIpc(deps: IpcDeps): void {
  const worktreeOf = makeWorktreeResolver(deps.db)

  handle('files:tree', ({ workspaceId }) => listDir(worktreeOf(workspaceId), ''))

  handle('files:listDir', ({ workspaceId, path }) => listDir(worktreeOf(workspaceId), path))

  handle('files:read', ({ workspaceId, path }) => readFileJailed(worktreeOf(workspaceId), path))

  // The dialog only picks; every returned path is still vetted by the attachments
  // module at send time, so choosing a file grants nothing by itself.
  handle('files:pickExternal', async (): Promise<{ paths: string[] }> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Attach files',
      properties: ['openFile', 'multiSelections']
    })
    return { paths: canceled ? [] : filePaths }
  })
}
