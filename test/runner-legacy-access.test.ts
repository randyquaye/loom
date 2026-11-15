import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunnerServerOptions } from '../src/main/runner/server'
import type { Caller } from '../src/main/ipc/registry'
import type { SessionEventPush } from '../src/shared/ipc-contract'

const harness = vi.hoisted(() => ({
  server: null as RunnerServerOptions | null,
  sendTo: vi.fn(),
  sessionSink: (_push: SessionEventPush) => {},
  activity: { revision: 1, bySession: { personal: 'personal-w', shared: 'bot-w' } }
}))
vi.mock('../src/main/runner/server', async (original) => ({
  ...(await original<object>()),
  startRunnerServer: async (options: RunnerServerOptions) => {
    harness.server = options
    return {
      port: 3877,
      sendTo: harness.sendTo,
      connectedUsers: () => ['reader'],
      forwardedWorkspaces: () => [],
      closeWorkspaceForwards: () => {},
      closeWhere: () => {},
      close: async () => {}
    }
  }
}))
vi.mock('../src/main/sessions/service', async (original) => ({
  ...(await original<object>()),
  sessionActivity: () => harness.activity,
  setSessionSink: (sink: (push: SessionEventPush) => void) => {
    harness.sessionSink = sink
  }
}))
import { openDb } from '../src/main/db'
import { createOrgService } from '../src/main/org/service'
import { createBotService } from '../src/main/bots/repository'
import { startRunner } from '../src/main/runner/runner'
import { robotConfig } from '../src/shared/bots'
import { SESSION_ACTIVITY_CHANNEL, SESSION_EVENT_CHANNEL } from '../src/shared/ipc-contract'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  harness.server = null
  harness.sendTo.mockClear()
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-legacy-access-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const db = openDb(path.join(root, 'loom.db'))
  for (const id of ['owner', 'reader']) {
    db.prepare('INSERT INTO users(id,email,created_at) VALUES (?,?,0)').run(id, `${id}@example.com`)
    db.prepare(
      "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES (?,?,'human','active',0)"
    ).run(id, id === 'owner' ? 'owner' : 'member')
  }
  db.exec("INSERT INTO organization(singleton,name,created_by,created_at) VALUES (1,'Org','owner',0)")
  const org = createOrgService(db, { ownerEmail: 'owner@example.com', publicUrl: 'https://loom.example.com' })
  const bots = createBotService({ db, org })
  const bot = bots.create('owner', 'robot', { ...robotConfig(), repositories: ['example/repo'] })
  bots.setGrant('owner', bot.id, 'reader', 'control')
  db.exec("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project','/fixture',0)")
  for (const [id, ownerId, sessionId] of [
    ['personal-w', 'reader', 'personal'],
    ['bot-w', bot.id, 'shared']
  ]) {
    db.prepare(
      "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id,state) VALUES (?,'p',?,?,?,0,?,'ready')"
    ).run(id, id, `loom/${id}`, path.join(root, id!), ownerId)
    db.prepare(
      "INSERT INTO sessions(id,workspace_id,backend,model,effort,title,created_at) VALUES (?,?,'codex','gpt-6.1-sol','high',?,0)"
    ).run(sessionId, id, sessionId)
    db.prepare('INSERT INTO events_rendered(session_id,text) VALUES (?,?)').run(
      sessionId,
      'forest discussion'
    )
    db.prepare("INSERT INTO events(session_id,seq,ts,type,payload) VALUES (?,1,0,'text.done',?)").run(
      sessionId,
      JSON.stringify({ type: 'text.done', turnId: 't', text: 'forest discussion' })
    )
  }
  db.close()
  const runner = await startRunner({
    dataDir: root,
    secretKey: randomBytes(32),
    devIdentities: ['owner', 'reader'].map((id) => ({ userId: id, email: `${id}@example.com`, token: id })),
    host: '127.0.0.1',
    port: 0,
    placement: { runtime: 'machine', checkout: 'worktree' },
    allowLocalRemotes: true,
    signIn: {
      google: { authorizeUrl: () => '', identify: async () => null },
      domains: ['example.com'],
      ownerEmail: 'owner@example.com',
      googleClientId: 'client',
      publicUrl: 'https://loom.example.com',
      signingKey: generateKeyPairSync('ed25519')
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
      transportProofFile: path.join(root, 'transport.json')
    }
  })
  cleanup.push(() => runner.close())
  const options = harness.server!
  const legacy: Caller = { userId: 'reader', capabilities: [] }
  const capable: Caller = { userId: 'reader', capabilities: ['bots.v1'] }
  return {
    options,
    legacy,
    capable,
    call: (channel: string, input: unknown, caller = legacy) => options.dispatch(caller, channel, input)
  }
}

describe('baseline clients on a bot-capable runner', () => {
  it('keeps the old owner roster human-only while capable owners can administer bots', async () => {
    const h = await fixture()
    const roster = (await h.call('org:members', undefined, { userId: 'owner', capabilities: [] })) as Array<{
      kind: string
    }>
    expect(roster).toHaveLength(2)
    expect(roster.every((member) => member.kind === 'human')).toBe(true)
    const capable = (await h.call('org:members', undefined, {
      userId: 'owner',
      capabilities: ['bots.v1']
    })) as Array<{ kind: string }>
    expect(capable.some((member) => member.kind === 'bot')).toBe(true)
  })

  it('returns personal workspaces/history/unread/activity without leaking granted bot data', async () => {
    const h = await fixture()
    expect(await h.call('workspaces:list', { projectId: 'p' })).toEqual([
      expect.objectContaining({ id: 'personal-w' })
    ])
    expect(await h.call('history:search', { query: 'forest', projectId: null })).toEqual([
      expect.objectContaining({ sessionId: 'personal' })
    ])
    expect(Object.keys((await h.call('sessions:unread', undefined)) as object)).toEqual(['personal'])
    expect(await h.call('sessions:activity', undefined)).toEqual({
      revision: 1,
      bySession: { personal: 'personal-w' }
    })
    expect(
      ((await h.call('workspaces:list', { projectId: 'p' }, h.capable)) as Array<{ id: string }>)
        .map((row) => row.id)
        .sort()
    ).toEqual(['bot-w', 'personal-w'])
    expect(Object.keys((await h.call('sessions:unread', undefined, h.capable)) as object).sort()).toEqual([
      'personal',
      'shared'
    ])
    expect(
      (
        (await h.call('history:search', { query: 'forest', projectId: null }, h.capable)) as Array<{
          sessionId: string
        }>
      )
        .map((hit) => hit.sessionId)
        .sort()
    ).toEqual(['personal', 'shared'])
  })

  it('refuses legacy direct bot-subject calls and forwards while preserving capable grants', async () => {
    const h = await fixture()
    await expect(h.call('sessions:events', { sessionId: 'shared' })).rejects.toThrow(/not found/)
    expect(await h.call('sessions:events', { sessionId: 'shared' }, h.capable)).toHaveLength(1)
    expect(h.options.mayForward?.(h.legacy, 'bot-w')).toBe(false)
    expect(h.options.mayForward?.(h.capable, 'bot-w')).toBe(true)
    expect(h.options.mayForward?.(h.legacy, 'personal-w')).toBe(true)
  })

  it('projects pushes per connection and identifies bot session pushes without changing their payload', async () => {
    const h = await fixture()
    const personal = {
      sessionId: 'personal',
      event: { type: 'text.done' as const, turnId: 't', text: 'personal' }
    }
    const bot = { ...personal, sessionId: 'shared' }
    expect(h.options.pushFor?.(h.legacy, SESSION_EVENT_CHANNEL, personal, 'personal-w')).toBe(personal)
    expect(h.options.pushFor?.(h.legacy, SESSION_EVENT_CHANNEL, bot, 'bot-w')).toBeUndefined()
    expect(h.options.pushFor?.(h.legacy, 'bots:changed', { botId: 'robot' })).toBeUndefined()
    expect(h.options.pushFor?.(h.capable, SESSION_EVENT_CHANNEL, bot, 'bot-w')).toBe(bot)
    expect(h.options.pushFor?.(h.legacy, SESSION_ACTIVITY_CHANNEL, harness.activity)).toEqual({
      revision: 1,
      bySession: { personal: 'personal-w' }
    })
    harness.sessionSink(bot)
    expect(harness.sendTo).toHaveBeenCalledWith(
      'reader',
      SESSION_EVENT_CHANNEL,
      expect.objectContaining({ sessionId: 'shared' }),
      'bot-w'
    )
  })
})
