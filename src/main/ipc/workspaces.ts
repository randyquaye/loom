import { getProjectOrThrow } from '../db/repos/projects'
import { getWorkspaceOrThrow, listWorkspaces, setWorkspaceArchived } from '../db/repos/workspaces'
import { readRepoSettings } from '../config/repo-settings'
import { createTerminal, terminalIdForCwd, writeTerminal } from '../pty'
import { createWorkspace, removeWorkspace, workspaceEnv } from '../workspace/bootstrap'
import { handle, type IpcDeps } from './handle'

export function registerWorkspacesIpc(deps: IpcDeps): void {
  handle('workspaces:list', ({ projectId }) => listWorkspaces(deps.db, projectId))

  handle('workspaces:add', ({ projectId, name, baseRef }) =>
    createWorkspace({ db: deps.db, dataRoot: deps.dataRoot, projectId, name, baseRef })
  )

  handle('workspaces:remove', async ({ id }) => {
    const workspace = getWorkspaceOrThrow(deps.db, id)
    const project = getProjectOrThrow(deps.db, workspace.projectId)
    await removeWorkspace({ db: deps.db, repoPath: project.repoPath, workspace })
  })

  handle('workspaces:setArchived', ({ id, archived }) => {
    getWorkspaceOrThrow(deps.db, id)
    setWorkspaceArchived(deps.db, id, archived)
  })

  handle('workspaces:scripts', async ({ workspaceId }) => {
    const workspace = getWorkspaceOrThrow(deps.db, workspaceId)
    const project = getProjectOrThrow(deps.db, workspace.projectId)
    const settings = await readRepoSettings(project.repoPath)
    return {
      runMode: settings.runMode,
      actions: settings.run.map((action) => ({
        id: action.id,
        icon: action.icon,
        isDefault: action.isDefault
      }))
    }
  })

  handle('workspaces:runAction', async ({ workspaceId, actionId }) => {
    const workspace = getWorkspaceOrThrow(deps.db, workspaceId)
    const project = getProjectOrThrow(deps.db, workspace.projectId)
    const settings = await readRepoSettings(project.repoPath)
    const action = settings.run.find((entry) => entry.id === actionId)
    if (action === undefined) throw new Error(`unknown run action ${actionId}`)
    const env = await workspaceEnv(deps.db, workspaceId)
    let terminalId = terminalIdForCwd(workspace.worktreePath)
    if (terminalId === null) terminalId = createTerminal(workspace.worktreePath, env)
    writeTerminal(terminalId, `${action.command}\n`)
    return terminalId
  })
}
