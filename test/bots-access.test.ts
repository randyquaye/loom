import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { ensureUser } from '../src/main/db/repos/users'
import { createOrgService } from '../src/main/org/service'
import { createBotService } from '../src/main/bots/repository'
import { createAccess } from '../src/main/runner/access'
import { robotConfig } from '../src/shared/bots'

let db: Database.Database
let org: ReturnType<typeof createOrgService>
let bots: ReturnType<typeof createBotService>
let access: ReturnType<typeof createAccess>
let botId: string

beforeEach(() => {
  db = openDb(':memory:')
  org = createOrgService(db, { ownerEmail: 'owner@example.com', publicUrl: 'https://loom.example.com' })
  ensureUser(db, { id: 'owner', email: 'owner@example.com' })
  org.admitGoogle('owner', 'owner@example.com', '')
  for (const id of ['viewer', 'controller', 'other']) {
    ensureUser(db, { id, email: `${id}@example.com` })
    db.prepare(
      "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES (?,'member','human','active',0)"
    ).run(id)
  }
  bots = createBotService({ db, org })
  botId = bots.create('owner', 'robot', { ...robotConfig(), repositories: ['example/project'] }).id
  bots.setGrant('owner', botId, 'viewer', 'view')
  bots.setGrant('owner', botId, 'controller', 'control')
  db.exec("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project','/tmp/project',0)")
  for (const [id, ownerId] of [
    ['bot-w', botId],
    ['human-w', 'other'],
    ['controller-w', 'controller']
  ]) {
    db.prepare(
      "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id) VALUES (?,'p',?,?,?,0,?)"
    ).run(id, id, `loom/${id}`, `/tmp/${id}`, ownerId)
    db.prepare(
      "INSERT INTO sessions(id,workspace_id,backend,model,effort,title,created_at) VALUES (?,?,'codex','gpt-6.1-sol','high','Session',0)"
    ).run(`${id}-session`, id)
  }
  db.exec(
    "INSERT INTO diff_comments(id,workspace_id,path,line,body,created_at) VALUES ('comment','bot-w','file.ts',1,'Review',0)"
  )
  access = createAccess(db, org.owner)
})
afterEach(() => db.close())

describe('bot workspace permissions', () => {
  it('keeps legacy clients on personal work even when their human has bot grants', () => {
    const legacy = { userId: 'controller', capabilities: [] }
    const capable = { userId: 'controller', capabilities: ['bots.v1'] }
    expect(access.mayViewWorkspace('controller', 'controller-w', [])).toBe(true)
    expect(access.mayViewWorkspace('controller', 'bot-w', [])).toBe(false)
    expect(access.mayControlWorkspace('controller', 'bot-w', [])).toBe(false)
    expect(access.mayViewWorkspace('controller', 'bot-w', ['bots.v1'])).toBe(true)
    expect(access.mayViewWorkspace('controller', 'bot-w')).toBe(true)
    expect(() =>
      access.assertMayCall(legacy, 'sessions:events', { sessionId: 'controller-w-session' })
    ).not.toThrow()
    for (const [channel, input] of [
      ['sessions:events', { sessionId: 'bot-w-session' }],
      ['files:read', { workspaceId: 'bot-w' }],
      ['ports:forward', { workspaceId: 'bot-w', port: 3000 }],
      ['comments:remove', { id: 'comment' }]
    ] as const) {
      expect(() => access.assertMayCall(legacy, channel, input)).toThrow(/not found/)
      expect(() => access.assertMayCall(capable, channel, input)).not.toThrow()
    }
    for (const channel of ['bots:list', 'bots:invoke', 'bots:open', 'bots:create', 'bots:setGrant']) {
      expect(() => access.assertMayCall({ userId: 'owner', capabilities: [] }, channel, {})).toThrow(
        /support|upgrade|update|capabil/i
      )
    }
    const activity = { revision: 1, bySession: { own: 'controller-w', shared: 'bot-w' } }
    expect(access.activityFor('controller', activity, []).bySession).toEqual({ own: 'controller-w' })
    expect(access.activityFor('controller', activity, ['bots.v1']).bySession).toEqual(activity.bySession)
  })

  it('preserves the terminal creator when another authorized controller reuses its run action', () => {
    access.noteResult({ userId: 'controller' }, 'terminal:create', 'shared-terminal', {
      workspaceId: 'bot-w'
    })
    access.noteResult({ userId: 'owner' }, 'workspaces:runAction', 'shared-terminal', {
      workspaceId: 'bot-w'
    })
    expect(access.ownerOf('terminal', 'shared-terminal')).toBe('controller')
    expect(() =>
      access.assertMayCall({ userId: 'owner' }, 'terminal:write', { id: 'shared-terminal' })
    ).not.toThrow()
    expect(() =>
      access.assertMayCall({ userId: 'controller' }, 'terminal:write', { id: 'shared-terminal' })
    ).not.toThrow()
  })

  it('lets viewers inspect bot descendants while denying execution and all unrelated human work', () => {
    for (const channel of [
      'workspaces:power',
      'ports:list',
      'git:status',
      'git:diff',
      'git:checkpoints',
      'sessions:list',
      'sessions:closed',
      'files:tree',
      'files:listDir',
      'files:read',
      'files:preview',
      'terminal:list'
    ]) {
      expect(() =>
        access.assertMayCall({ userId: 'viewer' }, channel, { workspaceId: 'bot-w' })
      ).not.toThrow()
    }
    for (const channel of [
      'sessions:events',
      'sessions:eventsAfter',
      'sessions:instructions',
      'sessions:exportMarkdown',
      'sessions:queue',
      'sessions:markRead'
    ]) {
      expect(() =>
        access.assertMayCall({ userId: 'viewer' }, channel, { sessionId: 'bot-w-session' })
      ).not.toThrow()
    }
    for (const channel of [
      'workspaces:start',
      'workspaces:stop',
      'ports:forward',
      'workspaces:runAction',
      'sessions:create',
      'terminal:create',
      'terminal:attach',
      'git:restoreCheckpoint',
      'comments:add',
      'lint:run'
    ]) {
      expect(() => access.assertMayCall({ userId: 'viewer' }, channel, { workspaceId: 'bot-w' })).toThrow()
    }
    for (const channel of [
      'sessions:send',
      'sessions:steer',
      'sessions:answerQuestion',
      'sessions:cancel',
      'sessions:close',
      'sessions:dequeue',
      'files:upload'
    ]) {
      expect(() =>
        access.assertMayCall({ userId: 'viewer' }, channel, { sessionId: 'bot-w-session' })
      ).toThrow()
    }
    for (const userId of ['owner', 'viewer', 'controller']) {
      expect(access.mayViewWorkspace(userId, 'human-w')).toBe(false)
      expect(() =>
        access.assertMayCall({ userId }, 'sessions:events', { sessionId: 'human-w-session' })
      ).toThrow(/not found/)
    }
    expect(() => access.assertMayCall({ userId: 'viewer' }, 'future:unknown', {})).toThrow(/not available/)
  })

  it('resolves terminal and comment authority through the current bot workspace grant', () => {
    access.noteResult({ userId: 'controller' }, 'terminal:create', 'terminal-1', { workspaceId: 'bot-w' })
    expect(access.workspaceOf('terminal', 'terminal-1')).toBe('bot-w')
    expect(access.workspaceOf('comment', 'comment')).toBe('bot-w')
    expect(() =>
      access.assertMayCall({ userId: 'controller' }, 'terminal:write', { id: 'terminal-1' })
    ).not.toThrow()
    expect(() => access.assertMayCall({ userId: 'viewer' }, 'terminal:write', { id: 'terminal-1' })).toThrow()
    expect(() =>
      access.assertMayCall({ userId: 'controller' }, 'comments:remove', { id: 'comment' })
    ).not.toThrow()
    bots.setGrant('owner', botId, 'controller', null)
    expect(() =>
      access.assertMayCall({ userId: 'controller' }, 'terminal:write', { id: 'terminal-1' })
    ).toThrow()
    expect(() =>
      access.assertMayCall({ userId: 'controller' }, 'comments:remove', { id: 'comment' })
    ).toThrow()
    access.noteResult({ userId: 'other' }, 'terminal:create', 'legacy-terminal')
    expect(() =>
      access.assertMayCall({ userId: 'other' }, 'terminal:write', { id: 'legacy-terminal' })
    ).not.toThrow()
  })

  it('forbids cross-owner transcript forks and retains history viewing when execution is disabled', () => {
    expect(() =>
      access.assertMayCall({ userId: 'controller' }, 'sessions:fork', {
        workspaceId: 'bot-w',
        sourceSessionId: 'controller-w-session'
      })
    ).toThrow(/not found|owner/i)
    expect(() =>
      access.assertMayCall({ userId: 'controller' }, 'sessions:fork', {
        workspaceId: 'bot-w',
        sourceSessionId: 'bot-w-session'
      })
    ).not.toThrow()
    bots.update('owner', botId, { ...robotConfig(), repositories: ['example/project'] }, false, 1)
    expect(access.mayViewWorkspace('controller', 'bot-w')).toBe(true)
    expect(access.mayControlWorkspace('controller', 'bot-w')).toBe(false)
    expect(() =>
      access.assertMayCall({ userId: 'controller' }, 'sessions:send', { sessionId: 'bot-w-session' })
    ).toThrow()
  })

  it('filters activity and recipients using live human membership and grants rather than administration', () => {
    bots.setGrant('owner', botId, 'owner', null)
    const activity = { revision: 1, bySession: { 'bot-w-session': 'bot-w', 'human-w-session': 'human-w' } }
    expect(access.activityFor('viewer', activity).bySession).toEqual({ 'bot-w-session': 'bot-w' })
    expect(access.activityFor('owner', activity).bySession).toEqual({})
    expect(access.viewers('bot-w')).toEqual(expect.arrayContaining(['viewer', 'controller']))
    expect(access.viewers('bot-w')).not.toContain('owner')
    org.remove('owner', 'viewer')
    expect(access.mayViewWorkspace('viewer', 'bot-w')).toBe(false)
    expect(access.activityFor('viewer', activity).bySession).toEqual({})
    expect(access.viewers('bot-w')).not.toContain('viewer')
  })
})
