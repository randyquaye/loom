import { afterEach, expect, it, vi } from 'vitest'
import type { Notification } from '../../shared/notifications'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('preserves entries and cards on a failed refresh, but accepts a successful empty list', async () => {
  vi.useFakeTimers()
  const warning: Notification = {
    id: 'warning',
    ownerId: 'owner',
    workspaceId: 'workspace',
    kind: 'idle-prompt',
    createdAt: 1,
    readAt: null,
    closedAt: null,
    payload: { reason: 'forward', answer: null, stopAt: 100_000, outcome: null }
  }
  const list = vi.fn<() => Promise<Notification[]>>().mockResolvedValue([warning])
  vi.stubGlobal('window', { loom: { notifications: { list } } })
  const { useNotifications } = await import('./notifications')

  await useNotifications.getState().load()
  expect(useNotifications.getState().items).toEqual([warning])
  expect(useNotifications.getState().cards).toEqual([warning.id])

  list.mockRejectedValueOnce(new Error('Cloud notification read failed'))
  await expect(useNotifications.getState().load()).rejects.toThrow('Cloud notification read failed')
  expect(useNotifications.getState().items).toEqual([warning])
  expect(useNotifications.getState().cards).toEqual([warning.id])

  list.mockResolvedValueOnce([])
  await useNotifications.getState().load()
  expect(useNotifications.getState().items).toEqual([])
  expect(useNotifications.getState().cards).toEqual([])
})
