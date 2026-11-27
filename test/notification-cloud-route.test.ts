import { afterEach, expect, it, vi } from 'vitest'
import type { RunnerClientOptions } from '../src/main/cloud/client'
import type { Notification } from '../src/shared/notifications'

const harness = vi.hoisted(() => ({
  call: vi.fn(),
  options: null as RunnerClientOptions | null
}))
vi.mock('../src/main/cloud/port-forwards', () => ({
  createPortForwards: () => ({ disconnect: vi.fn(), close: vi.fn() })
}))
vi.mock('../src/main/cloud/client', async (original) => ({
  ...(await original<object>()),
  connectRunner: (options: RunnerClientOptions) => {
    harness.options = options
    return { call: harness.call, callIdentified: harness.call, reconnect: vi.fn(), close: vi.fn() }
  }
}))

import { openDb } from '../src/main/db'
import { createCloudRoute, type CloudRoute } from '../src/main/cloud/route'
import { register } from '../src/main/ipc/registry'
import { ipcSchemas } from '../src/shared/ipc-contract'

let db: ReturnType<typeof openDb>
let route: CloudRoute

afterEach(() => {
  route?.close()
  db?.close()
})

it('rejects failed cloud notification reads instead of returning a successful local-only list', async () => {
  db = openDb(':memory:')
  const cloud: Notification = {
    id: 'cloud-warning',
    ownerId: 'owner',
    workspaceId: 'workspace',
    kind: 'idle-prompt',
    createdAt: 2,
    readAt: null,
    closedAt: null,
    payload: { reason: 'forward', answer: null, stopAt: 100_000, outcome: null }
  }
  const local: Notification = {
    ...cloud,
    id: 'local-history',
    ownerId: null,
    createdAt: 1,
    closedAt: 2,
    payload: { ...cloud.payload, answer: 'no', outcome: 'stopped' }
  }
  register('notifications:list', ipcSchemas['notifications:list'], () => [local])
  harness.call.mockImplementation(async (channel: string) =>
    channel === 'sessions:activity' ? { revision: 0, bySession: {} } : [cloud]
  )
  route = createCloudRoute({
    db,
    dataRoot: '/unused',
    url: 'ws://127.0.0.1',
    token: async () => 'fixture',
    toWindow: vi.fn()
  })
  harness.options!.onState({ state: 'connected' })
  expect(await route.route('notifications:list', undefined)).toEqual([cloud, local])

  harness.call.mockRejectedValueOnce(new Error('Cloud notification read failed'))
  await expect(route.route('notifications:list', undefined)).rejects.toThrow('Cloud notification read failed')

  harness.call.mockResolvedValueOnce([])
  expect(await route.route('notifications:list', undefined)).toEqual([local])
})
