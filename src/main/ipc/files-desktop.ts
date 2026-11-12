import { stat } from 'node:fs/promises'
import { dialog, shell } from 'electron'
import { NotAFileError } from '../fs/read'
import { makeWorktreeResolver } from '../fs/workspace-root'
import { contain } from '../security/contain'
import { handle, type IpcDeps } from './registry'

/** File actions that need the Mac itself: Finder and the native open dialog. */
export function registerDesktopFilesIpc(deps: IpcDeps): void {
  const worktreeOf = makeWorktreeResolver(deps.db)

  handle('files:reveal', async ({ workspaceId, path }) => {
    const abs = await contain(worktreeOf(workspaceId), path)
    if (!(await stat(abs)).isFile()) throw new NotAFileError(`not a regular file: ${path}`)
    shell.showItemInFolder(abs)
  })

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
