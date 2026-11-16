import { create } from 'zustand'
import type { DesktopUpdateStatus } from '../../shared/desktop-updates'

type UpdateAction = 'check' | 'download' | 'install'

interface DesktopUpdatesState {
  status: DesktopUpdateStatus | null
  pending: UpdateAction | null
  error: string | null
  interacted: boolean
  run(action: UpdateAction): Promise<void>
}

let revision = 0

/** Main owns the update; the renderer asks only after the person chooses an action. */
export const useDesktopUpdates = create<DesktopUpdatesState>((set, get) => ({
  status: null,
  pending: null,
  error: null,
  interacted: false,
  async run(action) {
    if (get().pending !== null) return
    const mine = ++revision
    set({ pending: action, error: null, interacted: true })
    try {
      await window.loom.updates[action]()
    } catch (error) {
      if (mine === revision) set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ pending: null })
    }
  }
}))

let subscribed = false

/** A startup snapshot cannot replace a newer pushed status or a person's action. */
export function subscribeDesktopUpdates(): void {
  if (subscribed) return
  subscribed = true
  window.loom.onUpdateStatus((status) => {
    revision++
    useDesktopUpdates.setState({ status, error: null })
  })
  const mine = revision
  void window.loom.updates.status().then(
    (status) => {
      if (mine === revision) useDesktopUpdates.setState({ status })
    },
    (error: unknown) => {
      if (mine === revision)
        useDesktopUpdates.setState({ error: error instanceof Error ? error.message : String(error) })
    }
  )
}
