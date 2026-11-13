import { create } from 'zustand'
import type { WorkspacePower, WorkspacePowerPush } from '../../shared/ipc-contract'

interface PowerState {
  byWorkspace: Record<string, WorkspacePower>
  apply(push: WorkspacePowerPush): void
  load(workspaceId: string): Promise<void>
  start(workspaceId: string): Promise<void>
  stop(workspaceId: string): Promise<void>
}

const revisions = new Map<string, number>()
const next = (id: string): number => {
  const value = (revisions.get(id) ?? 0) + 1
  revisions.set(id, value)
  return value
}

export const useWorkspacePower = create<PowerState>((set) => {
  async function request(id: string, action: () => Promise<WorkspacePower>): Promise<void> {
    const revision = next(id)
    const power = await action()
    if (revisions.get(id) === revision)
      set((state) => ({ byWorkspace: { ...state.byWorkspace, [id]: power } }))
  }
  return {
    byWorkspace: {},
    apply({ workspaceId, ...power }) {
      next(workspaceId)
      set((state) => ({ byWorkspace: { ...state.byWorkspace, [workspaceId]: power } }))
    },
    load: (id) => request(id, () => window.loom.workspaces.power(id)),
    start: (id) => request(id, () => window.loom.workspaces.start(id)),
    stop: (id) => request(id, () => window.loom.workspaces.stop(id))
  }
})

let subscribed = false
export function subscribeWorkspacePower(): void {
  if (subscribed) return
  subscribed = true
  window.loom.onWorkspacePower((push) => useWorkspacePower.getState().apply(push))
}
