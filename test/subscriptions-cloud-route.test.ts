import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerClientOptions } from '../src/main/cloud/client'

const harness = vi.hoisted(() => ({
  call: vi.fn(),
  local: vi.fn(),
  options: null as RunnerClientOptions | null
}))
vi.mock('../src/main/cloud/port-forwards', () => ({
  createPortForwards: () => ({ list: () => [], disconnect: vi.fn(), close: async () => {} })
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
beforeEach(() => {
  db = openDb(':memory:')
  harness.call.mockReset().mockResolvedValue({ from: 'runner' })
  harness.local.mockReset()
  for (const [channel, schema] of Object.entries(ipcSchemas)) register(channel, schema, harness.local)
  route = createCloudRoute({
    db,
    dataRoot: '/unused',
    url: 'ws://127.0.0.1',
    token: async () => 'fixture',
    toWindow: vi.fn()
  })
  harness.options!.onState({ state: 'connected', capabilities: ['subscriptions.v1'] })
})
afterEach(() => {
  route.close()
  db.close()
})

describe('subscription desktop routing', () => {
  it('always administers accounts and bot pool grants on the runner', async () => {
    expect(await route.route('subscriptions:list', undefined)).toEqual({ from: 'runner' })
    expect(
      await route.route('subscriptions:setGrant', { botId: 'bot', provider: 'claude', allowed: false })
    ).toEqual({ from: 'runner' })
    expect(harness.call).toHaveBeenCalledWith('subscriptions:list', undefined)
    expect(harness.call).toHaveBeenCalledWith('subscriptions:setGrant', {
      botId: 'bot',
      provider: 'claude',
      allowed: false
    })
    expect(harness.local).not.toHaveBeenCalled()
  })

  it('does not fall back to desktop credentials when the runner rejects a subscription request', async () => {
    harness.call.mockRejectedValueOnce(new Error('Subscription account is unavailable'))
    await expect(route.route('subscriptions:status', { accountId: 'account' })).rejects.toThrow(/unavailable/)
    expect(harness.local).not.toHaveBeenCalled()
  })
})
