import { makeWorktreeResolver } from '../fs/workspace-root'
import { addComment, listComments, removeComment, rewriteCommentsFile } from '../db/repos/comments'
import { handle, type IpcDeps } from './index'

export function registerCommentsIpc(deps: IpcDeps): void {
  const worktreeOf = makeWorktreeResolver(deps.db)

  handle('comments:list', ({ workspaceId }) => listComments(deps.db, workspaceId))

  handle('comments:add', async (input) => {
    const row = addComment(deps.db, input)
    await rewriteCommentsFile(worktreeOf(input.workspaceId), listComments(deps.db, input.workspaceId))
    return row
  })

  handle('comments:remove', async ({ id }) => {
    const workspaceId = removeComment(deps.db, id)
    if (workspaceId !== null) {
      await rewriteCommentsFile(worktreeOf(workspaceId), listComments(deps.db, workspaceId))
    }
  })
}
