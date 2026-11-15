import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { createOrgService } from '../src/main/org/service'
import { createBotService } from '../src/main/bots/repository'
import { createBotInvocations } from '../src/main/bots/invocations'
import { registerBotHandlers } from '../src/main/bots/handlers'
import { dispatch } from '../src/main/ipc/registry'
import { createAccess } from '../src/main/runner/access'
import type { Logins } from '../src/main/logins/service'
import type { BotGithub } from '../src/main/bots/github'
import { robotConfig } from '../src/shared/bots'

const databases: ReturnType<typeof openDb>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  for (const id of ['owner', 'viewer']) {
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
  bots.setGrant('owner', bot.id, 'viewer', 'view')
  const logins = {
    connectClaude: vi.fn(async () => {}),
    connectCodex: vi.fn(),
    status: vi.fn(async () => ({
      managed: true,
      claude: true,
      codex: false,
      github: false,
      codexSigningIn: false
    })),
    disconnect: vi.fn(),
    revokeAccess: vi.fn()
  } as unknown as Logins
  const github = { configure: vi.fn(), invalidate: vi.fn(), remove: vi.fn() } as unknown as BotGithub
  const invocations = createBotInvocations({ db, bots, provision: () => undefined })
  const changed = vi.fn()
  registerBotHandlers({
    db,
    bots,
    org,
    invocations,
    logins,
    github,
    access: createAccess(db, org.owner),
    changed
  })
  return { db, bots, bot, logins, github, invocations, changed }
}

describe('bot administration boundary', () => {
  it('opens disabled bot history with viewing capability even for a controller', async () => {
    const { db, bot, bots, invocations } = fixture()
    const accepted = invocations.invoke('owner', {
      botId: bot.id,
      repository: 'example/repo',
      prompt: 'Explain',
      requestKey: 'paused'
    })
    await invocations.idle()
    db.prepare("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','repo','/fixture',0)").run()
    db.prepare(
      "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id) VALUES (?,'p','bot','loom/bot','/fixture',0,?)"
    ).run(accepted.workspaceId, bot.id)
    bots.update('owner', bot.id, bot.config, false, bot.revision)
    expect(dispatch('bots:open', { invocationId: accepted.id }, { userId: 'owner' })).toMatchObject({
      workspace: { bot: { access: 'view' } }
    })
  })
  it.each(['bots:connectClaude', 'bots:connectCodex'] as const)(
    'refuses bot-owned subscription sign-in through %s even for owners',
    async (channel) => {
      const { bot, logins } = fixture()
      const input =
        channel === 'bots:connectClaude' ? { botId: bot.id, token: 'fixture-token' } : { botId: bot.id }
      await expect(
        Promise.resolve().then(() => dispatch(channel, input, { userId: 'owner' }))
      ).rejects.toThrow(/organization|subscription/i)
      expect(logins.connectClaude).not.toHaveBeenCalled()
      expect(logins.connectCodex).not.toHaveBeenCalled()
    }
  )

  it('refuses viewer credential administration while retaining bot GitHub configuration', () => {
    const { bot, logins, github } = fixture()
    expect(() => dispatch('bots:logins', { botId: bot.id }, { userId: 'viewer' })).toThrow()
    expect(() =>
      dispatch(
        'bots:setGithub',
        { botId: bot.id, appId: '1', installationId: '2', privateKey: 'fixture' },
        { userId: 'viewer' }
      )
    ).toThrow()
    expect(github.configure).not.toHaveBeenCalled()
    expect(logins.connectClaude).not.toHaveBeenCalled()
  })

  it('keeps metadata administration separate from conversation visibility', async () => {
    const { bots, bot, invocations } = fixture()
    const accepted = invocations.invoke('owner', {
      botId: bot.id,
      repository: 'example/repo',
      prompt: 'Explain',
      requestKey: 'one'
    })
    await invocations.idle()
    bots.setGrant('owner', bot.id, 'owner', null)
    expect(dispatch('bots:list', undefined, { userId: 'owner' }) as unknown[]).toHaveLength(1)
    expect(() => dispatch('bots:open', { invocationId: accepted.id }, { userId: 'owner' })).toThrow()
    expect(dispatch('bots:open', { invocationId: accepted.id }, { userId: 'viewer' })).toMatchObject({
      invocation: { id: accepted.id },
      workspace: null
    })
  })

  it('audits configuration and revocation before quiescing bot resources', async () => {
    const { bot, changed } = fixture()
    await dispatch(
      'bots:update',
      {
        botId: bot.id,
        config: { ...bot.config, instructions: 'Updated bot instructions' },
        enabled: false,
        revision: bot.revision
      },
      { userId: 'owner' }
    )
    expect(changed).toHaveBeenCalledWith(bot.id, true)
  })
})
