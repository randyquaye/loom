import { makeWorktreeResolver } from '../fs/workspace-root'
import { lintFile } from '../lint/adapters'
import { contain } from '../security/contain'
import { handle, type IpcDeps } from './index'

export function registerLintIpc(deps: IpcDeps): void {
  const worktreeOf = makeWorktreeResolver(deps.db)

  // Lint works on the supplied text, not disk, but the path is still renderer input and must be jailed.
  handle('lint:run', async ({ workspaceId, path, text }) => {
    await contain(worktreeOf(workspaceId), path)
    return lintFile(path, text)
  })
}
