import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { ensureUser } from '../src/main/db/repos/users'
import { createOrgService } from '../src/main/org/service'
import { createBotService } from '../src/main/bots/repository'
import { searchHistory } from '../src/main/ipc/history'
import { markSessionRead, unreadSessions } from '../src/main/sessions/unread'
import { robotConfig } from '../src/shared/bots'

let db: Database.Database
let botId: string
let otherBotId: string

beforeEach(() => {
  db = openDb(':memory:')
  const org = createOrgService(db, { ownerEmail: 'owner@example.com', publicUrl: 'https://loom.example.com' })
  ensureUser(db, { id: 'owner', email: 'owner@example.com' })
  org.admitGoogle('owner', 'owner@example.com', '')
  for (const id of ['one', 'two', 'hidden']) {
    ensureUser(db, { id, email: `${id}@example.com` })
    db.prepare(
      "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES (?,'member','human','active',0)"
    ).run(id)
  }
  const bots = createBotService({ db, org })
  const config = { ...robotConfig(), repositories: ['example/project'] }
  botId = bots.create('owner', 'robot', config).id
  otherBotId = bots.create('owner', 'other', config).id
  bots.setGrant('owner', botId, 'one', 'view')
  bots.setGrant('owner', botId, 'two', 'view')
  db.exec("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project','/tmp/project',0)")
  for (const [id, ownerId] of [
    ['bot-w', botId],
    ['other-bot-w', otherBotId],
    ['personal-w', 'one'],
    ['hidden-w', 'hidden']
  ]) {
    db.prepare(
      "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id) VALUES (?,'p',?,?,?,0,?)"
    ).run(id, id, `loom/${id}`, `/tmp/${id}`, ownerId)
  }
})
afterEach(() => db.close())

function session(id: string, workspaceId: string, createdAt = 0): void {
  db.prepare(
    "INSERT INTO sessions(id,workspace_id,backend,model,effort,title,created_at) VALUES (?,?,'codex','gpt-6.1-sol','high',?,?)"
  ).run(id, workspaceId, id, createdAt)
  db.prepare('INSERT INTO events_rendered(session_id,text) VALUES (?,?)').run(id, 'forest discussion')
}

function answer(sessionId: string, seq: number): void {
  db.prepare("INSERT INTO events(session_id,seq,ts,type,payload) VALUES (?,?,0,'text.done',?)").run(
    sessionId,
    seq,
    JSON.stringify({ text: `Answer ${seq}` })
  )
}

describe('shared bot history and read progress', () => {
  it('keeps each viewer cursor independent, monotone, and bounded by currently existing events', () => {
    session('bot-s', 'bot-w')
    answer('bot-s', 1)
    answer('bot-s', 2)
    db.prepare('UPDATE sessions SET last_read_seq=2 WHERE id=?').run('bot-s')
    expect(unreadSessions(db, 'one', ['bot-w'])['bot-s']?.seq).toBe(2)
    expect(unreadSessions(db, 'two', ['bot-w'])['bot-s']?.seq).toBe(2)
    markSessionRead(db, 'bot-s', 2, 'one')
    expect(unreadSessions(db, 'one', ['bot-w'])['bot-s']).toBeUndefined()
    expect(unreadSessions(db, 'two', ['bot-w'])['bot-s']?.seq).toBe(2)
    markSessionRead(db, 'bot-s', 1, 'one')
    markSessionRead(db, 'bot-s', 999, 'two')
    expect(db.prepare('SELECT user_id,last_read_seq FROM bot_session_reads ORDER BY user_id').all()).toEqual([
      { user_id: 'one', last_read_seq: 2 },
      { user_id: 'two', last_read_seq: 2 }
    ])
    answer('bot-s', 3)
    expect(unreadSessions(db, 'one', ['bot-w'])['bot-s']?.seq).toBe(3)
    expect(unreadSessions(db, 'two', ['bot-w'])['bot-s']?.seq).toBe(3)
  })

  it('preserves personal read progress and does not create shared cursors for human sessions', () => {
    session('personal-s', 'personal-w')
    answer('personal-s', 1)
    answer('personal-s', 2)
    markSessionRead(db, 'personal-s', 1, 'one')
    markSessionRead(db, 'personal-s', 0, 'one')
    expect(unreadSessions(db, 'one')['personal-s']?.seq).toBe(2)
    markSessionRead(db, 'personal-s', 2)
    expect(unreadSessions(db, 'one')['personal-s']).toBeUndefined()
    expect(db.prepare('SELECT * FROM bot_session_reads WHERE session_id=?').all('personal-s')).toEqual([])
    expect(db.prepare('SELECT last_read_seq FROM sessions WHERE id=?').get('personal-s')).toEqual({
      last_read_seq: 2
    })
  })

  it('filters bot history inside SQL before recent and search limits, rejecting extra human workspace IDs', () => {
    for (let index = 0; index < 65; index++) session(`hidden-${index}`, 'hidden-w', 100 + index)
    session('other-bot-s', 'other-bot-w', 99)
    session('bot-s', 'bot-w', 1)
    session('personal-s', 'personal-w', 2)
    const visible = ['bot-w', 'hidden-w', 'missing-w']
    expect(searchHistory(db, '', null, 'one', visible).map((hit) => hit.sessionId)).toEqual([
      'personal-s',
      'bot-s'
    ])
    expect(
      searchHistory(db, 'forest', null, 'one', visible)
        .map((hit) => hit.sessionId)
        .sort()
    ).toEqual(['bot-s', 'personal-s'])
    expect(searchHistory(db, '', null, 'one').map((hit) => hit.sessionId)).toEqual(['personal-s'])
    for (const id of ['hidden-0', 'other-bot-s', 'bot-s', 'personal-s']) answer(id, 1)
    expect(Object.keys(unreadSessions(db, 'one', visible)).sort()).toEqual(['bot-s', 'personal-s'])
  })

  it('excludes removed bot owners even when a stale visible workspace list still contains them', () => {
    session('bot-s', 'bot-w')
    answer('bot-s', 1)
    db.prepare("UPDATE org_members SET state='removed' WHERE user_id=?").run(botId)
    expect(searchHistory(db, 'forest', null, 'one', ['bot-w'])).toEqual([])
    expect(unreadSessions(db, 'one', ['bot-w'])).toEqual({})
  })
})
