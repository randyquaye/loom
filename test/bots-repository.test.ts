import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { migrate } from '../src/main/db/migrations'
import { ensureUser, userForGoogle } from '../src/main/db/repos/users'
import { createOrgService } from '../src/main/org/service'
import { createBotService, readBot } from '../src/main/bots/repository'
import { robotConfig } from '../src/shared/bots'

let db: Database.Database
let org: ReturnType<typeof createOrgService>
let bots: ReturnType<typeof createBotService>

beforeEach(() => {
  db = openDb(':memory:')
  org = createOrgService(db, { ownerEmail: 'owner@example.com', publicUrl: 'https://loom.example.com' })
  ensureUser(db, { id: 'owner', email: 'owner@example.com' })
  org.admitGoogle('owner', 'owner@example.com', '')
  for (const [id, role] of [
    ['viewer', 'member'],
    ['admin', 'owner']
  ] as const) {
    ensureUser(db, { id, email: `${id}@example.com` })
    db.prepare(
      "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES (?,?,'human','active',0)"
    ).run(id, role)
  }
  bots = createBotService({ db, org })
})
afterEach(() => db.close())

const config = () => ({ ...robotConfig(), repositories: ['example/project'] })

describe('bot configuration and membership authority', () => {
  it('rejects repository lists spanning installation owners before creating or replacing a bot configuration', () => {
    const mixed = { ...config(), repositories: ['example/project', 'another/other'] }
    expect(() => bots.create('owner', 'mixed', mixed)).toThrow(/one GitHub.*owner|same.*owner/i)
    expect(bots.list('owner')).toEqual([])
    const bot = bots.create('owner', 'robot', {
      ...config(),
      repositories: ['example/project', 'example/other']
    })
    expect(bot.config.repositories).toEqual(['example/project', 'example/other'])
    expect(() => bots.update('owner', bot.id, mixed, true, bot.revision)).toThrow(
      /one GitHub.*owner|same.*owner/i
    )
    expect(readBot(db, bot.id)).toMatchObject({ revision: 1, config: bot.config })
  })

  it('creates a nonhuman member with an explicit creator grant and separate administrative visibility', () => {
    const bot = bots.create('owner', 'robot', config())
    expect(org.member(bot.id)).toMatchObject({ kind: 'bot', role: 'member', state: 'active' })
    expect(bot.access).toBe('control')
    expect(bots.grants('owner', bot.id)).toEqual([
      { userId: 'owner', email: 'owner@example.com', access: 'control' }
    ])
    expect(bots.list('viewer')).toEqual([])
    expect(() => bots.get('viewer', bot.id)).toThrow(/not found|access/i)
    expect(bots.get('admin', bot.id).access).toBeNull()
    expect(() => bots.assertControl('admin', bot.id)).toThrow(/control|access/i)
    expect(() => bots.create('viewer', 'other', config())).toThrow(/owner/i)
  })

  it('saves validated canonical repository grants and rejects authority hidden in malformed configuration', () => {
    const bot = bots.create('owner', 'robot', {
      ...config(),
      repositories: ['https://github.com/Example/Project.git', 'git@github.com:Example/Other.git']
    })
    expect(bot.config.repositories).toEqual(['example/project', 'example/other'])
    const rejected = [
      'https://github.com.evil.test/example/project',
      'https://name:password@github.com/example/project',
      'https://github.com/example/project?token=secret',
      'https://github.com/example/project#main',
      'https://github.com/example/other/../project',
      'https://github.com/example/other/%2e%2e/project',
      'example/*',
      'example/../private',
      'file:///tmp/private',
      '/tmp/private'
    ]
    for (const repository of rejected) {
      expect(() =>
        bots.update('owner', bot.id, { ...config(), repositories: [repository] }, true, 1)
      ).toThrow()
    }
    expect(() => bots.update('owner', bot.id, { ...config(), model: '--model=anything' }, true, 1)).toThrow(
      /model/i
    )
    expect(() => bots.update('owner', bot.id, { ...config(), repositories: [] }, true, 1)).toThrow()
    expect(readBot(db, bot.id)?.revision).toBe(1)
  })

  it('updates revisions optimistically without changing previously returned configuration snapshots', () => {
    const original = bots.create('owner', 'robot', config())
    const next = bots.update(
      'owner',
      original.id,
      { ...config(), instructions: 'Updated instructions' },
      true,
      1
    )
    expect(next.revision).toBe(2)
    expect(original.config.instructions).not.toBe(next.config.instructions)
    expect(() => bots.update('owner', original.id, config(), false, 1)).toThrow(/changed|revision/i)
    expect(readBot(db, original.id)).toMatchObject({ revision: 2, enabled: true })
  })

  it('retains viewing while paused and removes old human grants permanently during offboarding', () => {
    const bot = bots.create('owner', 'robot', config())
    bots.setGrant('owner', bot.id, 'viewer', 'control')
    bots.update('owner', bot.id, config(), false, 1)
    expect(bots.get('viewer', bot.id)).toMatchObject({ enabled: false, access: 'control' })
    expect(() => bots.assertControl('viewer', bot.id)).toThrow(/disabled|paused/i)
    org.remove('owner', 'viewer')
    expect(() => bots.get('viewer', bot.id)).toThrow(/active|member|access/i)
    db.prepare(
      "UPDATE org_members SET state='active',removed_at=NULL,removed_by=NULL WHERE user_id='viewer'"
    ).run()
    expect(bots.list('viewer')).toEqual([])
    expect(bots.grants('owner', bot.id).map((grant) => grant.userId)).toEqual(['owner'])
  })

  it('never binds a bot to Google or grants it organization owner authority', () => {
    const bot = bots.create('owner', 'robot', config())
    const email = org.member(bot.id)!.email
    expect(() => userForGoogle(db, { subject: 'google-bot', email })).toThrow(/bot|human/i)
    expect(() => org.admitGoogle(bot.id, email, '')).toThrow(/bot|human/i)
    expect(() => org.setRole('owner', bot.id, 'owner')).toThrow(/bot|human/i)
    expect(db.prepare('SELECT google_subject FROM users WHERE id=?').get(bot.id)).toEqual({
      google_subject: null
    })
    expect(org.member(bot.id)?.role).toBe('member')
    expect(() => bots.create(bot.id, 'another', config())).toThrow(/human|owner/i)
    expect(() => bots.setGrant('owner', bot.id, bot.id, 'control')).toThrow(/human/i)
  })

  it('rolls back bot identity, membership, grant, and configuration when audit storage fails', () => {
    db.exec(
      "CREATE TRIGGER reject_bot_audit BEFORE INSERT ON org_admin_log BEGIN SELECT RAISE(ABORT, 'audit failed'); END"
    )
    expect(() => bots.create('owner', 'robot', config())).toThrow('audit failed')
    expect(db.prepare("SELECT COUNT(*) AS n FROM org_members WHERE kind='bot'").get()).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@loom.invalid'").get()).toEqual({
      n: 0
    })
    expect(bots.list('owner')).toEqual([])
  })

  it('keeps removed bots inaccessible despite leftover grants and retained configuration', () => {
    const bot = bots.create('owner', 'robot', config())
    bots.setGrant('owner', bot.id, 'viewer', 'view')
    org.remove('owner', bot.id)
    expect(bots.list('viewer')).toEqual([])
    expect(() => bots.get('owner', bot.id)).toThrow(/not found|removed/i)
    expect(() => bots.assertControl('viewer', bot.id)).toThrow()
  })
})

describe('organization bot migration', () => {
  it('preserves populated human workspaces, provider conversations and snapshots when adding bot tables', () => {
    db.exec(
      'DROP TABLE bot_invocations; DROP TABLE bot_session_reads; DROP TABLE bot_grants; DROP TABLE bots;'
    )
    db.prepare("DELETE FROM _migrations WHERE name='018_bots'").run()
    db.exec("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project','/tmp/project',1)")
    db.exec(
      "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id) VALUES ('w','p','Work','loom/work','/tmp/work',2,'owner')"
    )
    db.exec(
      "INSERT INTO sessions(id,workspace_id,backend,model,effort,title,created_at,provider_session_id,instruction_snapshot) VALUES ('s','w','codex','gpt-6.1-sol','high','Session',3,'provider-thread','Original instructions')"
    )
    db.exec(
      "INSERT INTO events(session_id,seq,ts,type,payload) VALUES ('s',1,4,'text.done','{\"text\":\"saved answer\"}')"
    )
    const before = db.prepare('SELECT * FROM sessions WHERE id=?').get('s')
    migrate(db)
    migrate(db)
    expect(db.prepare('SELECT * FROM sessions WHERE id=?').get('s')).toEqual(before)
    expect(db.prepare('SELECT owner_id FROM workspaces WHERE id=?').get('w')).toEqual({ owner_id: 'owner' })
    expect(db.prepare('SELECT payload FROM events WHERE session_id=?').get('s')).toEqual({
      payload: '{"text":"saved answer"}'
    })
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(bots.create('owner', 'robot', config()).config.name).toBe('Robot')
  })
})
