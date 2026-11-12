import { afterEach, expect, it, vi } from 'vitest'
import type { CloudStatus } from '../../shared/ipc-contract'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('reloads workspace lists and catches tabs up each time the runner connection comes up', async () => {
  vi.resetModules()
  let push!: (status: CloudStatus) => void
  vi.stubGlobal('window', {
    loom: {
      onWorkspaceState: vi.fn(),
      onCloudStatus: (listener: typeof push) => {
        push = listener
      },
      // What main knew when the window asked: older than the push that follows.
      cloud: { status: async (): Promise<CloudStatus> => ({ state: 'connecting' }) }
    }
  })
  const { useProjects } = await import('./projects')
  const { useSessions } = await import('./sessions')
  const { subscribeCloud, useCloud } = await import('./cloud')
  const load = vi.fn(async () => {})
  const catchUp = vi.fn(async () => {})
  useProjects.setState({ load })
  useSessions.setState({ catchUp })

  subscribeCloud()
  push({ state: 'connected' })
  await vi.waitFor(() => expect(catchUp).toHaveBeenCalledTimes(1))

  // Cloud workspaces are only listed once the runner can be asked, so the lists reload.
  expect(load).toHaveBeenCalledTimes(1)
  expect(useCloud.getState().status).toEqual({ state: 'connected' })

  push({ state: 'unreachable' })
  push({ state: 'connecting' })
  expect(load).toHaveBeenCalledTimes(1)
  push({ state: 'connected' })
  await vi.waitFor(() => expect(catchUp).toHaveBeenCalledTimes(2))
  expect(load).toHaveBeenCalledTimes(2)
})
