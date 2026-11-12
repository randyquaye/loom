import { create } from 'zustand'
import type { CloudStatus } from '../../shared/ipc-contract'
import { useProjects } from './projects'
import { useSessions } from './sessions'

interface CloudState {
  status: CloudStatus
}

/** Whether this Loom follows a runner, and how that connection is doing. */
export const useCloud = create<CloudState>(() => ({ status: { state: 'off' } }))

/**
 * Cloud workspaces can only be listed while the runner can be asked, and whatever their
 * tabs did while it could not is missing here. Both are fetched when the connection comes up.
 */
async function connected(): Promise<void> {
  await useProjects.getState().load()
  await useSessions.getState().catchUp()
}

/**
 * Without a runner, this Mac numbers its own busy tabs again, from behind where the merged
 * numbering had reached, so what it says now replaces what is held rather than racing it.
 */
async function stopped(): Promise<void> {
  useSessions.setState({ activity: await window.loom.sessions.activity() })
  await useProjects.getState().load()
}

let subscribed = false

export function subscribeCloud(): void {
  if (subscribed) return
  subscribed = true
  let pushed = false
  const apply = (status: CloudStatus): void => {
    const before = useCloud.getState().status.state
    useCloud.setState({ status })
    if (status.state === 'connected' && before !== 'connected') {
      void connected().catch((error: unknown) => console.error('Could not catch up with the runner', error))
    }
    if (status.state === 'off' && before !== 'off') {
      void stopped().catch((error: unknown) => console.error('Could not go back to local only', error))
    }
  }
  window.loom.onCloudStatus((status) => {
    pushed = true
    apply(status)
  })
  void window.loom.cloud
    .status()
    // The answer describes the moment it was asked; a change pushed since then is newer.
    .then((status) => {
      if (!pushed) apply(status)
    })
    .catch((error: unknown) => console.error('Could not load the cloud status', error))
}
