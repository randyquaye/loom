import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { ensureUser } from '../src/main/db/repos/users'
import { createOrgService } from '../src/main/org/service'
import { createAccess } from '../src/main/runner/access'
import { ipcSchemas, type LoomApi } from '../src/shared/ipc-contract'

const bridge = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke }
}))

const inputs = {
  'subscriptions:list': undefined,
  'subscriptions:create': { provider: 'claude', label: 'Team Claude' },
  'subscriptions:update': {
    accountId: 'account',
    label: 'Team Claude',
    enabled: false,
    expectedEnabled: true
  },
  'subscriptions:connectClaude': { accountId: 'account', token: 'fixture-setup-token' },
  'subscriptions:connectCodex': { accountId: 'account' },
  'subscriptions:status': { accountId: 'account' },
  'subscriptions:disconnect': { accountId: 'account' },
  'subscriptions:grants': { botId: 'bot' },
  'subscriptions:setGrant': { botId: 'bot', provider: 'codex', allowed: false }
} as const

let db: Database.Database
beforeEach(() => {
  db = openDb(':memory:')
  bridge.invoke.mockReset()
  bridge.expose.mockClear()
})
afterEach(() => db.close())

describe('organization subscription administration boundary', () => {
  it('requires both organization ownership and subscription capability for every administration call', () => {
    const org = createOrgService(db, { ownerEmail: 'owner@example.com', publicUrl: 'https://loom.example' })
    ensureUser(db, { id: 'owner', email: 'owner@example.com' })
    org.admitGoogle('owner', 'owner@example.com', '')
    ensureUser(db, { id: 'member', email: 'member@example.com' })
    db.exec(
      "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES ('member','member','human','active',0)"
    )
    const access = createAccess(db, org.owner)
    for (const [channel, input] of Object.entries(inputs)) {
      expect(() =>
        access.assertMayCall({ userId: 'owner', capabilities: ['subscriptions.v1'] }, channel, input)
      ).not.toThrow()
      expect(() =>
        access.assertMayCall(
          { userId: 'member', capabilities: ['subscriptions.v1', 'bots.v1'] },
          channel,
          input
        )
      ).toThrow(/owner/i)
      expect(() =>
        access.assertMayCall({ userId: 'owner', capabilities: ['bots.v1'] }, channel, input)
      ).toThrow(/support|update/i)
    }
    expect(() =>
      access.assertMayCall(
        { userId: 'owner', capabilities: ['subscriptions.v1'] },
        'subscriptions:future',
        {}
      )
    ).toThrow(/not available/i)
  })

  it('rejects renderer-supplied ownership, provider replacement, and malformed grants before dispatch', () => {
    const schemas = ipcSchemas as Record<string, { parse(input: unknown): unknown }>
    for (const [channel, input] of Object.entries(inputs))
      expect(schemas[channel]?.parse(input)).toEqual(input)
    const malformed = [
      ['subscriptions:list', {}],
      ['subscriptions:create', { provider: 'github', label: 'Wrong provider' }],
      ['subscriptions:create', { provider: 'claude', label: '  ' }],
      ['subscriptions:create', { provider: 'claude', label: 'Team', ownerId: 'member' }],
      ['subscriptions:update', { ...inputs['subscriptions:update'], provider: 'codex' }],
      ['subscriptions:update', { accountId: 'account', label: 'Team Claude', enabled: true }],
      ['subscriptions:update', { ...inputs['subscriptions:update'], expectedEnabled: 'false' }],
      ['subscriptions:connectClaude', { accountId: 'account', token: '' }],
      ['subscriptions:connectCodex', { accountId: 'account', botId: 'bot' }],
      ['subscriptions:setGrant', { botId: 'bot', provider: 'claude', allowed: 'false' }],
      ['subscriptions:setGrant', { botId: 'bot', provider: 'claude', allowed: true, userId: 'owner' }]
    ] as const
    for (const [channel, input] of malformed) expect(() => schemas[channel]!.parse(input)).toThrow()
  })

  it('carries account identity and explicit grant revocation intact through the desktop bridge', async () => {
    await import('../src/preload/index')
    const api = bridge.expose.mock.calls.at(-1)![1] as LoomApi
    await api.subscriptions.create('claude', 'Team Claude')
    await api.subscriptions.update('account', 'Team Claude', false, true)
    await api.subscriptions.connectClaude('account', 'fixture-setup-token')
    await api.subscriptions.connectCodex('account')
    await api.subscriptions.status('account')
    await api.subscriptions.disconnect('account')
    await api.subscriptions.grants('bot')
    await api.subscriptions.setGrant('bot', 'codex', false)
    await api.subscriptions.list()
    expect(bridge.invoke.mock.calls).toEqual(
      expect.arrayContaining(Object.entries(inputs).map(([channel, input]) => [channel, input]))
    )
    expect(bridge.invoke).toHaveBeenCalledTimes(9)
  })

  it('retains a disabled owner snapshot through validation and preload rather than defaulting it true', async () => {
    vi.resetModules()
    await import('../src/preload/index')
    const api = bridge.expose.mock.calls.at(-1)![1] as LoomApi
    const input = { accountId: 'account', label: 'Renamed', enabled: false, expectedEnabled: false }
    expect(ipcSchemas['subscriptions:update'].parse(input)).toEqual(input)
    await api.subscriptions.update('account', 'Renamed', false, false)
    expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith('subscriptions:update', input)
  })
})
