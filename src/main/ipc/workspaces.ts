import { getProjectOrThrow } from '../db/repos/projects'
import { getWorkspaceOrThrow, listWorkspaces, setWorkspaceArchived } from '../db/repos/workspaces'
import { readRepoSettings } from '../config/repo-settings'
import { createTerminal, terminalIdForCwd, writeTerminal } from '../pty'
import { runtimeFor } from '../runtime'
import { createWorkspace, removeWorkspace, repositoryRoot, workspaceEnv } from '../workspace/bootstrap'
import type { WorkspacePlacement } from '../workspace/placement'
import { handle, type IpcDeps } from './registry'

export function registerWorkspacesIpc(deps: IpcDeps, placement: WorkspacePlacement): void {
  const cloudOnly = (): never => {
    throw new Error('This action requires a connected cloud workspace')
  }
  handle('workspaces:power', cloudOnly)
  handle('workspaces:start', cloudOnly)
  handle('workspaces:stop', cloudOnly)
  handle('ports:list', cloudOnly)
  handle('ports:forward', cloudOnly)
  handle('ports:unforward', cloudOnly)
  handle('workspaces:list', ({ projectId }) => listWorkspaces(deps.db, projectId))

  handle('workspaces:add', ({ projectId, name, baseRef, cloud }) => {
    // A cloud request is answered by the runner; one that reaches here has no runner to go to.
    if (cloud) throw new Error('No cloud runner is configured for this Loom')
    return createWorkspace({ db: deps.db, dataRoot: deps.dataRoot, projectId, name, baseRef, ...placement })
  })

  handle('workspaces:remove', async ({ id }) => {
    const workspace = getWorkspaceOrThrow(deps.db, id)
    const project = getProjectOrThrow(deps.db, workspace.projectId)
    await removeWorkspace({ db: deps.db, repoPath: project.repoPath, workspace, dataRoot: deps.dataRoot })
  })

  handle('workspaces:setArchived', ({ id, archived }) => {
    getWorkspaceOrThrow(deps.db, id)
    setWorkspaceArchived(deps.db, id, archived)
  })

  handle('workspaces:scripts', async ({ workspaceId }) => {
    const workspace = getWorkspaceOrThrow(deps.db, workspaceId)
    const project = getProjectOrThrow(deps.db, workspace.projectId)
    const settings = await readRepoSettings(repositoryRoot(project, workspace))
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
    const settings = await readRepoSettings(repositoryRoot(project, workspace))
    const action = settings.run.find((entry) => entry.id === actionId)
    if (action === undefined) throw new Error(`unknown run action ${actionId}`)
    const env = await workspaceEnv(deps.db, workspaceId)
    let terminalId = terminalIdForCwd(workspace.worktreePath)
    if (terminalId === null) {
      const runtime = runtimeFor(workspace, deps.dataRoot)
      await runtime.ensureRunning()
      terminalId = createTerminal(workspace.worktreePath, env, runtime)
    }
    writeTerminal(terminalId, `${action.command}\n`)
    return terminalId
  })
}
