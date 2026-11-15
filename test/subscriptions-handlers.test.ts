import { afterEach, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { createOrgService } from '../src/main/org/service'
import { createBotService } from '../src/main/bots/repository'
import { createSubscriptions } from '../src/main/subscriptions/repository'
import { registerSubscriptionHandlers } from '../src/main/subscriptions/handlers'
import { dispatch } from '../src/main/ipc/registry'
import type { Logins } from '../src/main/logins/service'
import { robotConfig } from '../src/shared/bots'

const databases: ReturnType<typeof openDb>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  for (const id of ['owner', 'member']) {
    db.prepare('INSERT INTO users(id,email,created_at) VALUES (?,?,0)').run(id, `${id}@example.com`)
    db.prepare(
      "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES (?,?,'human','active',0)"
    ).run(id, id === 'owner' ? 'owner' : 'member')
  }
  db.prepare(
    "INSERT INTO organization(singleton,name,created_by,created_at) VALUES (1,'Fixture','owner',0)"
  ).run()
  const org = createOrgService(db, { ownerEmail: 'owner@example.com', publicUrl: 'https://loom.example.com' })
  const bots = createBotService({ db, org })
  const bot = bots.create('owner', 'robot', { ...robotConfig(), repositories: ['example/repo'] })
  const subscriptions = createSubscriptions({ db, org, isBot: (id) => id === bot.id })
  const account = subscriptions.create('owner', 'claude', 'Shared Claude')
  const logins = {
    connectClaude: vi.fn(async () => {}),
    connectCodex: vi.fn(async () => ({ url: 'https://chatgpt.com/device', code: 'AAAA-BBBB' })),
    status: vi.fn(async () => ({
      managed: true,
      claude: true,
      codex: false,
      github: false,
      codexSigningIn: false
    })),
    disconnect: vi.fn(async () => {}),
    revokeAccess: vi.fn()
  } as unknown as Logins
  const changed = vi.fn<(botId: string, stop: boolean) => Promise<void>>().mockResolvedValue(undefined)
  registerSubscriptionHandlers({ db, org, subscriptions, logins, changed })
  return { db, bot, account, subscriptions, logins, changed }
}

it('allows only owners to administer organization subscription accounts and grants', async () => {
  const h = fixture()
  expect(dispatch('subscriptions:list', undefined, { userId: 'owner' })).toMatchObject([{ id: h.account.id }])
  expect(() => dispatch('subscriptions:list', undefined, { userId: 'member' })).toThrow(/owner/i)
  await expect(
    dispatch(
      'subscriptions:setGrant',
      { botId: h.bot.id, provider: 'claude', allowed: true },
      { userId: 'member' }
    )
  ).rejects.toThrow(/owner/i)
  expect(h.subscriptions.grants('owner', h.bot.id)).toEqual({ claude: false, codex: false })
})

it('connects the organization slot, never a bot or an administrator credential identity', async () => {
  const h = fixture()
  await dispatch(
    'subscriptions:connectClaude',
    { accountId: h.account.id, token: 'fixture-token' },
    { userId: 'owner' }
  )
  expect(h.logins.connectClaude).toHaveBeenCalledWith(h.account.id, 'fixture-token', expect.any(Function))
  expect(h.db.prepare('SELECT id FROM users WHERE id=?').get(h.account.id)).toBeUndefined()
})

it.each(['role', 'sign-in', 'account-lifecycle'] as const)(
  'rejects delayed credential publication after %s authority changes',
  async (change) => {
    const h = fixture()
    h.db.prepare("INSERT INTO sign_ins(id,user_id,created_at) VALUES ('admin-sign-in','owner',0)").run()
    let release!: () => void
    let publicationStarted!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      publicationStarted = resolve
    })
    let published = false
    h.logins.connectClaude = vi.fn(async (_id, _token, assertMayCommit) => {
      publicationStarted()
      await waiting
      assertMayCommit?.()
      published = true
    })
    const pending = Promise.resolve(
      dispatch(
        'subscriptions:connectClaude',
        { accountId: h.account.id, token: 'fixture-token' },
        { userId: 'owner', signInId: 'admin-sign-in' }
      )
    ).then(
      () => 'published',
      (error: Error) => error.message
    )
    await started
    if (change === 'role') h.db.prepare("UPDATE org_members SET role='member' WHERE user_id='owner'").run()
    if (change === 'sign-in') h.db.prepare("UPDATE sign_ins SET revoked_at=1 WHERE id='admin-sign-in'").run()
    if (change === 'account-lifecycle') {
      h.subscriptions.update('owner', h.account.id, { label: h.account.label, enabled: false })
      h.subscriptions.update('owner', h.account.id, { label: h.account.label, enabled: true })
    }
    release()
    expect(await pending).not.toBe('published')
    expect(published).toBe(false)
  }
)

it('attempts every affected bot cleanup when disabling a shared account even if one cleanup fails', async () => {
  const h = fixture()
  vi.spyOn(h.subscriptions, 'affectedBots').mockReturnValue(['first-bot', 'second-bot'])
  h.changed.mockImplementation(async (id: string) => {
    if (id === 'first-bot') throw new Error('Fixture stop failure')
  })
  await expect(
    Promise.resolve(
      dispatch(
        'subscriptions:update',
        { accountId: h.account.id, label: h.account.label, enabled: false, expectedEnabled: true },
        { userId: 'owner' }
      )
    )
  ).rejects.toThrow(/stop|cleanup/i)
  expect(h.changed).toHaveBeenCalledWith('first-bot', true)
  expect(h.changed).toHaveBeenCalledWith('second-bot', true)
  expect(h.subscriptions.activeAccount(h.account.id)).toBeNull()
  expect(h.logins.revokeAccess).toHaveBeenCalledWith(h.account.id)
})

it('allows an owner to disconnect an already disabled subscription without restoring admission', async () => {
  const h = fixture()
  h.subscriptions.update('owner', h.account.id, { label: h.account.label, enabled: false })
  h.logins.disconnect = vi.fn(async (_id, _provider, assertMayCommit) => {
    assertMayCommit?.()
  })
  await dispatch('subscriptions:disconnect', { accountId: h.account.id }, { userId: 'owner' })
  expect(h.logins.disconnect).toHaveBeenCalledWith(h.account.id, 'claude', expect.any(Function))
  expect(h.subscriptions.activeAccount(h.account.id)).toBeNull()
})

it.each([false, true])('does not stop other bot work when updating an already disabled account to enabled=%s', async (enabled) => {
  const h = fixture()
  h.subscriptions.update('owner', h.account.id, { label: h.account.label, enabled: false })
  vi.spyOn(h.subscriptions, 'affectedBots').mockReturnValue([h.bot.id])
  await dispatch('subscriptions:update', { accountId: h.account.id, label: 'Updated label', enabled, expectedEnabled: false }, { userId: 'owner' })
  expect(h.changed).not.toHaveBeenCalled()
  expect(h.logins.revokeAccess).not.toHaveBeenCalled()
})

it('rejects an older disconnect after its account lifecycle changes during resource cleanup', async () => {
  const h = fixture()
  vi.spyOn(h.subscriptions, 'affectedBots').mockReturnValue([h.bot.id])
  let release!: () => void
  let entered!: () => void
  const cleanup = new Promise<void>((resolve) => {
    release = resolve
  })
  const stopping = new Promise<void>((resolve) => {
    entered = resolve
  })
  h.changed.mockImplementation(async () => {
    entered()
    await cleanup
  })
  const pending = Promise.resolve(
    dispatch('subscriptions:disconnect', { accountId: h.account.id }, { userId: 'owner' })
  ).then(
    () => 'deleted',
    () => 'rejected'
  )
  await stopping
  h.subscriptions.update('owner', h.account.id, { label: h.account.label, enabled: false })
  h.subscriptions.update('owner', h.account.id, { label: h.account.label, enabled: true })
  release()
  expect(await pending).toBe('rejected')
  expect(h.logins.disconnect).not.toHaveBeenCalled()
})
