import { rmdir } from 'node:fs/promises'
import path from 'node:path'
import { dialog } from 'electron'
import { WORKSPACES_DIR } from '../../shared/brand'
import {
  getProjectOrThrow,
  deleteProject,
  insertProject,
  listProjects,
  repoPathTaken
} from '../db/repos/projects'
import { listWorkspaces } from '../db/repos/workspaces'
import {
  addProjectFromClone,
  addProjectFromLocalPath,
  cloneToLocation,
  deleteOwnedRepo,
  initEmptyRepo,
  isAppOwnedRepo
} from '../git/projects'
import { slugify } from '../git/slug'
import { migrateProjectInstructions, saveProjectPrompts } from '../instructions/migrate-general'
import { removeWorkspace } from '../workspace/bootstrap'
import { handle, type IpcDeps } from './registry'

export function registerProjectsIpc(deps: IpcDeps): void {
  handle('projects:list', async () => {
    for (const project of listProjects(deps.db)) {
      await migrateProjectInstructions(deps.db, deps.dataRoot, project.id).catch((error: unknown) =>
        console.warn(`[loom] General instructions need recovery for ${project.name}:`, error)
      )
    }
    return listProjects(deps.db)
  })

  handle('projects:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a git repository',
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  })

  handle('projects:quickstart', async ({ name }) => {
    const project = await initEmptyRepo(deps.dataRoot, name)
    insertProject(deps.db, project)
    return project
  })

  handle('projects:clone', async ({ url, location, overwrite }) => {
    const project = await cloneToLocation(deps.dataRoot, url, location, overwrite, (candidate) =>
      repoPathTaken(deps.db, candidate)
    )
    insertProject(deps.db, project)
    return project
  })

  handle('projects:repoOwned', ({ id }) =>
    isAppOwnedRepo(deps.dataRoot, getProjectOrThrow(deps.db, id).repoPath)
  )

  handle('projects:add', async (input) => {
    const project =
      input.source.kind === 'local'
        ? await addProjectFromLocalPath(deps.dataRoot, input.name, input.source.path)
        : await addProjectFromClone(deps.dataRoot, input.name, input.source.url, (candidate) =>
            repoPathTaken(deps.db, candidate)
          )
    insertProject(deps.db, project)
    return project
  })

  handle('projects:setPrompts', ({ projectId, general, codeReview, fixErrors }) => {
    getProjectOrThrow(deps.db, projectId)
    return saveProjectPrompts(deps.db, deps.dataRoot, { projectId, general, codeReview, fixErrors })
  })

  handle('projects:remove', async ({ id, deleteRepo }) => {
    const project = getProjectOrThrow(deps.db, id)
    // ON DELETE CASCADE only drops rows; the worktrees and branches on disk have to go first.
    for (const workspace of listWorkspaces(deps.db, id)) {
      await removeWorkspace({
        db: deps.db,
        repoPath: project.repoPath,
        workspace,
        dataRoot: deps.dataRoot
      })
    }
    deleteProject(deps.db, id)
    // The cloned copy goes only when the user ticked the box: adopted folders are theirs,
    // and a repos dir another project row still points at stays put.
    if (deleteRepo) {
      await deleteOwnedRepo(deps.dataRoot, project.repoPath, (candidate) => repoPathTaken(deps.db, candidate))
    }
    await rmdir(path.join(deps.dataRoot, WORKSPACES_DIR, slugify(project.name))).catch(() => {})
  })
}
