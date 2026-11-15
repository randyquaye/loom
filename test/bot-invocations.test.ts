import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { createOrgService } from '../src/main/org/service'
import { createBotService } from '../src/main/bots/repository'
import { createBotInvocations } from '../src/main/bots/invocations'
import { robotConfig } from '../src/shared/bots'

const databases: ReturnType<typeof openDb>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  for (const id of ['owner', 'viewer', 'other']) {
    db.prepare('INSERT INTO users(id,email,created_at) VALUES (?,?,0)').run(id, `${id}@example.com`)
    db.prepare(
      "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES (?,?,'human','active',0)"
    ).run(id, id === 'owner' ? 'owner' : 'member')
  }
  db.prepare(
    "INSERT INTO organization(singleton,name,created_by,created_at) VALUES (1,'Test','owner',0)"
  ).run()
  const org = createOrgService(db, { ownerEmail: 'owner@example.com', publicUrl: 'https://loom.example.com' })
  const bots = createBotService({ db, org })
  const bot = bots.create('owner', 'robot', { ...robotConfig(), repositories: ['example/repo'] })
  const input = {
    botId: bot.id,
    repository: 'example/repo',
    prompt: 'Investigate the build failure',
    requestKey: 'request-1'
  }
  return { db, bots, bot, input }
}

describe('durable bot invocation admission', () => {
  it('reserves one immutable launch across simultaneous retries and rejects conflicting inputs', async () => {
    const { db, bots, input } = fixture()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const provision = vi.fn(async () => {
      await barrier
    })
    const service = createBotInvocations({ db, bots, provision })
    const first = service.invoke('owner', input)
    const retry = service.invoke('owner', input)
    expect(retry.id).toBe(first.id)
    expect(retry.workspaceId).toBe(first.workspaceId)
    expect(first.config.repositories).toEqual(['example/repo'])
    expect(() => service.invoke('owner', { ...input, prompt: 'Different work' })).toThrow(
      /different|conflict/i
    )
    await Promise.resolve()
    expect(provision).toHaveBeenCalledTimes(1)
    release()
    await service.idle()
    expect(service.get('owner', first.id).state).toBe('ready')
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_invocations').get()).toEqual({ n: 1 })
  })

  it('denies unauthorized viewers and repositories before reserving work', () => {
    const { db, bots, bot, input } = fixture()
    bots.setGrant('owner', bot.id, 'viewer', 'view')
    const service = createBotInvocations({ db, bots, provision: vi.fn() })
    expect(() => service.invoke('viewer', input)).toThrow()
    expect(() => service.invoke('owner', { ...input, repository: 'example/ungranted' })).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM bot_invocations').get()).toEqual({ n: 0 })
  })

  it('rechecks a requester grant after asynchronous provisioning work', async () => {
    const { db, bots, bot, input } = fixture()
    bots.setGrant('owner', bot.id, 'viewer', 'control')
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const dispatched = vi.fn()
    const service = createBotInvocations({
      db,
      bots,
      provision: async (_invocation, assertCurrent) => {
        await barrier
        assertCurrent()
        dispatched()
      }
    })
    const accepted = service.invoke('viewer', input)
    bots.setGrant('owner', bot.id, 'viewer', null)
    release()
    await service.idle()
    expect(dispatched).not.toHaveBeenCalled()
    expect(service.get('owner', accepted.id).state).toBe('failed')
  })

  it('retains accepted configuration and does not replay ambiguous work after restart', async () => {
    const { db, bots, bot, input } = fixture()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const service = createBotInvocations({
      db,
      bots,
      provision: async () => {
        await barrier
      }
    })
    const accepted = service.invoke('owner', input)
    bots.update('owner', bot.id, { ...bot.config, instructions: 'New configuration' }, true, bot.revision)
    const provision = vi.fn()
    const restarted = createBotInvocations({ db, bots, provision })
    restarted.recover()
    const recovered = restarted.get('owner', accepted.id)
    expect(recovered.state).toBe('interrupted')
    expect(recovered.config.instructions).toBe(accepted.config.instructions)
    expect(restarted.invoke('owner', input).id).toBe(accepted.id)
    expect(provision).not.toHaveBeenCalled()
    release()
    await service.idle()
    expect(restarted.get('owner', accepted.id).state).toBe('interrupted')
  })
})
