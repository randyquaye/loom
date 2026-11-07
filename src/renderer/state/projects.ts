import { create } from 'zustand'
import type { ProjectAddInput, ProjectRow, WorkspaceRow, WorkspaceState } from '../../shared/ipc-contract'

interface ProjectsState {
  projects: ProjectRow[]
  workspacesByProject: Record<string, WorkspaceRow[]>
  statusByProvider: Record<string, string>
  error: string | null
  load(): Promise<void>
  loadWorkspaces(projectId: string): Promise<void>
  addProject(input: ProjectAddInput): Promise<ProjectRow>
  /** Registers a project main already created (quick start, clone) and loads its workspaces. */
  adoptProject(project: ProjectRow): Promise<void>
  /** baseRef: branch to start the worktree from; null keeps the repo's current HEAD. */
  addWorkspace(projectId: string, name: string, baseRef?: string | null): Promise<WorkspaceRow>
  removeWorkspace(id: string): Promise<void>
  /** Main deletes every workspace (worktree and branch) first; the list is then reloaded. */
  removeProject(id: string, deleteRepo: boolean): Promise<void>
  setArchived(id: string, archived: boolean): Promise<void>
  /** Applies a pushed bootstrap state transition to the cached row. */
  applyWorkspaceState(workspaceId: string, state: WorkspaceState, name?: string): void
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  workspacesByProject: {},
  statusByProvider: {},
  error: null,

  async load() {
    try {
      const [projects, status] = await Promise.all([
        window.loom.projects.list(),
        window.loom.providers.status()
      ])
      const statusByProvider: Record<string, string> = {}
      for (const [id, s] of Object.entries(status)) statusByProvider[id] = s.state
      set({ projects, statusByProvider, error: null })
      await Promise.all(projects.map((p) => get().loadWorkspaces(p.id)))
    } catch (e) {
      set({ error: String(e) })
    }
  },

  async loadWorkspaces(projectId) {
    const workspaces = await window.loom.workspaces.list(projectId)
    set({ workspacesByProject: { ...get().workspacesByProject, [projectId]: workspaces } })
  },

  async addProject(input) {
    const project = await window.loom.projects.add(input)
    await get().adoptProject(project)
    return project
  },

  async adoptProject(project) {
    set({ projects: [...get().projects.filter((p) => p.id !== project.id), project] })
    await get().loadWorkspaces(project.id)
  },

  async addWorkspace(projectId, name, baseRef = null) {
    const workspace = await window.loom.workspaces.add(projectId, name, baseRef)
    set({
      workspacesByProject: {
        ...get().workspacesByProject,
        [projectId]: [...(get().workspacesByProject[projectId] ?? []), workspace]
      }
    })
    return workspace
  },

  async removeWorkspace(id) {
    await window.loom.workspaces.remove(id)
    const workspacesByProject: Record<string, WorkspaceRow[]> = {}
    for (const [projectId, list] of Object.entries(get().workspacesByProject)) {
      workspacesByProject[projectId] = list.filter((w) => w.id !== id)
    }
    set({ workspacesByProject })
  },

  async removeProject(id, deleteRepo) {
    await window.loom.projects.remove(id, deleteRepo)
    // load() only overwrites the keys it fetches, so drop the removed project's cached workspaces.
    const workspacesByProject = { ...get().workspacesByProject }
    delete workspacesByProject[id]
    set({ projects: get().projects.filter((p) => p.id !== id), workspacesByProject })
    await get().load()
  },

  async setArchived(id, archived) {
    await window.loom.workspaces.setArchived(id, archived)
    const workspacesByProject: Record<string, WorkspaceRow[]> = {}
    for (const [projectId, list] of Object.entries(get().workspacesByProject)) {
      workspacesByProject[projectId] = list.map((w) => (w.id === id ? { ...w, archived } : w))
    }
    set({ workspacesByProject })
  },

  applyWorkspaceState(workspaceId, state, name) {
    const workspacesByProject: Record<string, WorkspaceRow[]> = {}
    for (const [projectId, list] of Object.entries(get().workspacesByProject)) {
      workspacesByProject[projectId] = list.map((w) =>
        w.id === workspaceId ? { ...w, state, ...(name === undefined ? {} : { name }) } : w
      )
    }
    set({ workspacesByProject })
  }
}))

// Bootstrap state transitions arrive over a push channel; keep cached rows live
// so the sidebar reflects initializing/setting_up/ready/error — and model renames —
// without polling.
window.loom.onWorkspaceState((push) => {
  useProjects.getState().applyWorkspaceState(push.workspaceId, push.state, push.name)
})
