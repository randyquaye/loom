import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { ensureUser } from '../src/main/db/repos/users'
import { createBotService } from '../src/main/bots/repository'
import type { ClaudeLogin, CodexLogin } from '../src/main/logins/vault'
import type { Logins } from '../src/main/logins/service'
import { dispatch } from '../src/main/ipc/registry'
import { createOrgService } from '../src/main/org/service'
import { createSubscriptions } from '../src/main/subscriptions/repository'
import { registerSubscriptionHandlers } from '../src/main/subscriptions/handlers'
import { robotConfig } from '../src/shared/bots'

let db: Database.Database
let org: ReturnType<typeof createOrgService>
let bots: ReturnType<typeof createBotService>
let subscriptions: ReturnType<typeof createSubscriptions>
let time: number

const codex = (accountId = 'provider-account'): CodexLogin => ({
  provider: 'codex',
  accountId,
  accessToken: `access-${accountId}`,
  refreshToken: `refresh-${accountId}`,
  idToken: `identity-${accountId}`
})
const claude = (accessToken = 'claude-token'): ClaudeLogin => ({ provider: 'claude', accessToken })
const seatLogin = (
  accountId: string,
  seat: string,
  claim: 'chatgpt_user_id' | 'sub' = 'chatgpt_user_id'
): CodexLogin => ({
  ...codex(accountId),
  idToken: `header.${Buffer.from(
    JSON.stringify(
      claim === 'sub' ? { sub: seat } : { 'https://api.openai.com/auth': { chatgpt_user_id: seat } }
    )
  ).toString('base64url')}.signature`
})

beforeEach(() => {
  db = openDb(':memory:')
  org = createOrgService(db, { ownerEmail: 'owner@example.com', publicUrl: 'https://loom.example.com' })
  ensureUser(db, { id: 'owner', email: 'owner@example.com' })
  org.admitGoogle('owner', 'owner@example.com', '')
  ensureUser(db, { id: 'member', email: 'member@example.com' })
  db.exec(
    "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES ('member','member','human','active',0)"
  )
  bots = createBotService({ db, org })
  time = 100000
  subscriptions = service()
})
afterEach(() => db.close())

function service() {
  return createSubscriptions({ db, org, isBot: (id) => org.member(id)?.kind === 'bot', now: () => time })
}
function bot(slug = 'robot') {
  return bots.create('owner', slug, { ...robotConfig(), repositories: ['example/project'] }).id
}
function pending(botId: string, workspaceId: string) {
  db.prepare(
    `INSERT INTO bot_invocations
    (id,bot_id,requester_id,request_key,fingerprint,config_revision,config,repository,prompt,workspace_id,session_id,message_id,state,created_at,updated_at)
    VALUES (?,?,?,?,?,1,?,'example/project','Task',?,?,?,'preparing',?,?)`
  ).run(
    `inv-${workspaceId}`,
    botId,
    'owner',
    workspaceId,
    workspaceId,
    JSON.stringify({ ...robotConfig(), repositories: ['example/project'] }),
    workspaceId,
    `session-${workspaceId}`,
    `message-${workspaceId}`,
    time,
    time
  )
}
function connected(provider: 'claude' | 'codex', label = 'Shared account') {
  const account = subscriptions.create('owner', provider, label)
  const login = provider === 'codex' ? codex(label) : claude(label)
  const guard = subscriptions.assertLogin(account.id, login)
  guard()
  subscriptions.connected(account.id, login)
  return subscriptions.account(account.id)!
}

describe('organization subscription ownership and capacity', () => {
  it('requires active human owners, keeps account identities outside membership, and audits atomically', () => {
    const id = bot()
    expect(() => subscriptions.create('member', 'codex', 'No')).toThrow(/owner/i)
    expect(() => subscriptions.create(id, 'codex', 'No')).toThrow(/owner/i)
    expect(() => subscriptions.list('member')).toThrow(/owner/i)
    const account = subscriptions.create('owner', 'codex', 'Shared')
    expect(org.member(account.id)).toBeNull()
    expect(subscriptions.grants('owner', id)).toEqual({ claude: false, codex: false })
    expect(() => subscriptions.setGrant('owner', 'member', 'codex', true)).toThrow(/bot/i)
    db.exec(
      "CREATE TRIGGER reject_subscription_audit BEFORE INSERT ON org_admin_log BEGIN SELECT RAISE(ABORT,'audit failed'); END"
    )
    expect(() => subscriptions.update('owner', account.id, { label: 'Changed', enabled: false })).toThrow(
      'audit failed'
    )
    expect(subscriptions.account(account.id)).toMatchObject({ label: 'Shared', enabled: true })
  })

  it('rejects stale account edits without changing enabled state or writing an audit event', () => {
    const account = subscriptions.create('owner', 'claude', 'Shared')
    subscriptions.update('owner', account.id, { label: account.label, enabled: false })
    const audit = db.prepare('SELECT COUNT(*) AS n FROM org_admin_log').get()
    expect(() =>
      subscriptions.update('owner', account.id, {
        label: 'Stale editor',
        enabled: true,
        expectedEnabled: true
      })
    ).toThrow(/changed|reload/i)
    expect(subscriptions.account(account.id)).toMatchObject({ label: account.label, enabled: false })
    expect(db.prepare('SELECT COUNT(*) AS n FROM org_admin_log').get()).toEqual(audit)
  })

  it('shares one canonical account across bots and preserves its pinned binding after restart', () => {
    const first = bot(),
      second = bot('second')
    const account = connected('codex')
    for (const [id, workspace] of [
      [first, 'first-work'],
      [second, 'second-work']
    ]) {
      subscriptions.setGrant('owner', id!, 'codex', true)
      pending(id!, workspace!)
      expect(subscriptions.reserve(id!, 'codex', workspace!).id).toBe(account.id)
    }
    expect(subscriptions.account(account.id)?.assignedWorkspaces).toBe(2)
    subscriptions = service()
    expect(subscriptions.assigned(first, 'codex', 'first-work')?.id).toBe(account.id)
    expect(subscriptions.affectedBots(account.id).sort()).toEqual([first, second].sort())
    expect(subscriptions.account(account.id)).not.toHaveProperty('accessToken')
    expect(org.member(account.id)).toBeNull()
  })

  it('never exposes human workspaces, another bot reservation, or legacy unbound workspaces', () => {
    const first = bot(),
      second = bot('second')
    connected('codex')
    subscriptions.setGrant('owner', first, 'codex', true)
    pending(second, 'other-work')
    db.exec("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project','/tmp/p',0)")
    db.exec(
      "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id) VALUES ('human-work','p','Human','main','/tmp/h',0,'owner'),('legacy-work','p','Legacy','main','/tmp/l',0,'" +
        first +
        "')"
    )
    expect(subscriptions.assigned(first, 'codex', 'legacy-work')).toBeNull()
    expect(subscriptions.assigned(first, 'codex', 'human-work')).toBeNull()
    expect(() => subscriptions.reserve(first, 'codex', 'human-work')).toThrow(/workspace|reservation/i)
    expect(() => subscriptions.reserve(first, 'codex', 'other-work')).toThrow(/workspace|reservation/i)
  })

  it('distributes new work across usable accounts while preserving unavailable conversation bindings', () => {
    const id = bot()
    subscriptions.setGrant('owner', id, 'codex', true)
    const first = connected('codex', 'First')
    time++
    const second = connected('codex', 'Second')
    pending(id, 'one')
    pending(id, 'two')
    pending(id, 'three')
    expect(subscriptions.reserve(id, 'codex', 'one').id).toBe(first.id)
    time++
    expect(subscriptions.reserve(id, 'codex', 'two').id).toBe(second.id)
    subscriptions.update('owner', first.id, { label: 'First', enabled: false })
    expect(subscriptions.assigned(id, 'codex', 'one')).toBeNull()
    expect(() => subscriptions.reserve(id, 'codex', 'one')).toThrow(/assigned|available|disabled/i)
    expect(subscriptions.reserve(id, 'codex', 'three').id).toBe(second.id)
  })

  it('counts current workspaces and preparing reservations while preserving inactive affinity history', () => {
    const current = bot(),
      reserved = bot('reserved'),
      historical = bot('historical'),
      archived = bot('archived')
    const account = connected('codex')
    db.exec("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project','/tmp/p',0)")
    for (const id of [current, reserved, historical, archived])
      subscriptions.setGrant('owner', id, 'codex', true)
    for (const [owner, workspace, state] of [
      [current, 'active', 'ready'],
      [reserved, 'preparing', 'preparing'],
      [archived, 'archived', 'ready'],
      [historical, 'deleted', 'ready'],
      [historical, 'failed', 'failed'],
      [historical, 'interrupted', 'interrupted']
    ]) {
      pending(owner!, workspace!)
      subscriptions.reserve(owner!, 'codex', workspace!)
      db.prepare('UPDATE bot_invocations SET state=? WHERE workspace_id=?').run(state, workspace)
      if (['active', 'archived', 'deleted'].includes(workspace!)) {
        db.prepare(
          `INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id,archived)
          VALUES (?,'p',?,?,?,0,?,?)`
        ).run(
          workspace,
          workspace,
          `loom/${workspace}`,
          `/tmp/${workspace}`,
          owner,
          Number(workspace === 'archived')
        )
      }
    }
    db.prepare('DELETE FROM workspaces WHERE id=?').run('deleted')
    expect(subscriptions.account(account.id)?.assignedWorkspaces).toBe(2)
    expect(subscriptions.affectedBots(account.id).sort()).toEqual([current, reserved, archived].sort())
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM subscription_bindings WHERE account_id=?').get(account.id)
    ).toEqual({ n: 6 })
    expect(subscriptions.assigned(archived, 'codex', 'archived')?.id).toBe(account.id)
  })

  it('revokes archived running workspace credentials while excluding them from allocation load', async () => {
    const id = bot(),
      account = connected('codex')
    subscriptions.setGrant('owner', id, 'codex', true)
    pending(id, 'archived')
    subscriptions.reserve(id, 'codex', 'archived')
    db.exec("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project','/tmp/p',0)")
    db.prepare(
      `INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id,archived,runtime,power_state)
      VALUES ('archived','p','Archived','loom/archived','/tmp/archived',0,?,1,'container','running')`
    ).run(id)
    db.prepare("UPDATE bot_invocations SET state='ready' WHERE workspace_id='archived'").run()
    const revoked: string[] = []
    registerSubscriptionHandlers({
      db,
      org,
      subscriptions,
      logins: {
        revokeAccess: (userId: string) => {
          revoked.push(userId)
        }
      } as unknown as Logins,
      changed: async () => {}
    })
    expect(subscriptions.account(account.id)?.assignedWorkspaces).toBe(0)
    await dispatch(
      'subscriptions:update',
      {
        accountId: account.id,
        label: account.label,
        enabled: false,
        expectedEnabled: true
      },
      { userId: 'owner' }
    )
    expect(revoked).toContain(id)
  })

  it('balances new allocations after old conversations are archived or fail before workspace creation', () => {
    const id = bot()
    subscriptions.setGrant('owner', id, 'codex', true)
    const old = connected('codex', 'Old')
    for (const workspace of ['old-one', 'old-two']) {
      pending(id, workspace)
      subscriptions.reserve(id, 'codex', workspace)
      db.prepare("UPDATE bot_invocations SET state='failed' WHERE workspace_id=?").run(workspace)
    }
    time++
    const fresh = connected('codex', 'Fresh')
    pending(id, 'new-one')
    pending(id, 'new-two')
    expect(subscriptions.reserve(id, 'codex', 'new-one').id).toBe(fresh.id)
    expect(subscriptions.reserve(id, 'codex', 'new-two').id).toBe(old.id)
  })

  it('invalidates assignments immediately after grant revocation, bot removal, and account disable', () => {
    const id = bot()
    const account = connected('claude')
    subscriptions.setGrant('owner', id, 'claude', true)
    pending(id, 'one')
    subscriptions.reserve(id, 'claude', 'one')
    subscriptions.setGrant('owner', id, 'claude', false)
    expect(subscriptions.assigned(id, 'claude', 'one')).toBeNull()
    expect(subscriptions.available(id, 'claude')).toBe(false)
    subscriptions.setGrant('owner', id, 'claude', true)
    subscriptions.update('owner', account.id, { label: account.label, enabled: false })
    expect(subscriptions.assigned(id, 'claude', 'one')).toBeNull()
    subscriptions.update('owner', account.id, { label: account.label, enabled: true })
    org.remove('owner', id)
    expect(subscriptions.assigned(id, 'claude', 'one')).toBeNull()
    expect(subscriptions.available(id, 'claude')).toBe(false)
    db.prepare("UPDATE org_members SET state='active',removed_at=NULL,removed_by=NULL WHERE user_id=?").run(
      id
    )
    expect(subscriptions.grants('owner', id)).toEqual({ claude: false, codex: false })
    expect(subscriptions.assigned(id, 'claude', 'one')).toBeNull()
  })

  it('treats rate limiting as shared cooldown, retains failed authentication, and ignores request-level 403', () => {
    const id = bot()
    const account = connected('codex')
    subscriptions.setGrant('owner', id, 'codex', true)
    pending(id, 'one')
    subscriptions.reserve(id, 'codex', 'one')
    subscriptions.observe(id, 'codex', 'one', 403, {})
    expect(subscriptions.assigned(id, 'codex', 'one')?.id).toBe(account.id)
    subscriptions.observe(id, 'codex', 'one', 429, { 'retry-after': '10' })
    expect(subscriptions.account(account.id)).toMatchObject({ state: 'rate_limited', retryAt: time + 10000 })
    expect(subscriptions.available(id, 'codex')).toBe(false)
    expect(subscriptions.assigned(id, 'codex', 'one')).toBeNull()
    time += 10001
    expect(subscriptions.assigned(id, 'codex', 'one')?.id).toBe(account.id)
    subscriptions.observe(id, 'codex', 'one', 401, {})
    expect(subscriptions.account(account.id)?.state).toBe('auth_failed')
    expect(subscriptions.activeAccount(account.id)).toBeNull()
    expect(subscriptions.isAccount(account.id)).toBe(true)
    subscriptions.observe(id, 'codex', 'one', 429, { 'retry-after': '1' })
    time += 1001
    expect(subscriptions.account(account.id)?.state).toBe('auth_failed')
  })

  it('uses reset information conservatively and never treats another bot response as account evidence', () => {
    const id = bot(),
      other = bot('other')
    const account = connected('claude')
    subscriptions.setGrant('owner', id, 'claude', true)
    pending(id, 'one')
    subscriptions.reserve(id, 'claude', 'one')
    const reset = time + 60000
    subscriptions.observe(other, 'claude', 'one', 401, {})
    expect(subscriptions.account(account.id)?.state).toBe('ready')
    subscriptions.observe(id, 'claude', 'one', 429, {
      'retry-after': '2',
      'anthropic-ratelimit-unified-reset': String(reset / 1000)
    })
    const deadline = time + 2000
    expect(subscriptions.account(account.id)).toMatchObject({ retryAt: deadline, providerResetAt: reset })
    time += 1000
    subscriptions.observe(id, 'claude', 'one', 429, { 'retry-after': '1' })
    expect(subscriptions.account(account.id)).toMatchObject({ retryAt: deadline, providerResetAt: reset })
    expect(subscriptions.available(id, 'claude')).toBe(false)
  })

  it('uses explicit Retry-After instructions independently from longer observed provider windows', () => {
    const id = bot(),
      account = connected('claude')
    subscriptions.setGrant('owner', id, 'claude', true)
    pending(id, 'one')
    subscriptions.reserve(id, 'claude', 'one')
    const reset = time + 5 * 60 * 60 * 1000
    subscriptions.observe(id, 'claude', 'one', 429, {
      'retry-after': '10',
      'anthropic-ratelimit-unified-reset': String(reset / 1000)
    })
    expect(subscriptions.account(account.id)).toMatchObject({ retryAt: time + 10000, providerResetAt: reset })
    time += 10001
    expect(subscriptions.available(id, 'claude')).toBe(true)
    subscriptions.observe(id, 'claude', 'one', 429, {
      'anthropic-ratelimit-unified-reset': String(reset / 1000)
    })
    expect(subscriptions.account(account.id)).toMatchObject({ retryAt: reset, providerResetAt: reset })
  })

  it('retains pinned profile metadata while unavailable without granting credential execution', () => {
    const id = bot(),
      account = connected('codex')
    subscriptions.setGrant('owner', id, 'codex', true)
    pending(id, 'one')
    subscriptions.reserve(id, 'codex', 'one')
    subscriptions.observe(id, 'codex', 'one', 429, { 'retry-after': '10' })
    expect(subscriptions.bound(id, 'codex', 'one')).toMatchObject({ id: account.id, state: 'rate_limited' })
    expect(subscriptions.assigned(id, 'codex', 'one')).toBeNull()
    subscriptions.update('owner', account.id, { label: account.label, enabled: false })
    expect(subscriptions.bound(id, 'codex', 'one')).toMatchObject({ id: account.id, enabled: false })
    subscriptions.disconnected(account.id)
    expect(subscriptions.bound(id, 'codex', 'one')).toMatchObject({ id: account.id, state: 'disconnected' })
    subscriptions.setGrant('owner', id, 'codex', false)
    expect(subscriptions.bound(id, 'codex', 'one')).toBeNull()
  })

  it('rejects duplicate subscription identities across labels before credential publication', () => {
    const first = connected('codex', 'First')
    const duplicate = subscriptions.create('owner', 'codex', 'Alias')
    expect(() => subscriptions.assertLogin(duplicate.id, codex('First'))).toThrow(/already|duplicate/i)
    const sameToken = connected('claude', 'Token')
    const alias = subscriptions.create('owner', 'claude', 'Alias')
    expect(() => subscriptions.assertLogin(alias.id, claude('Token'))).toThrow(/already|duplicate/i)
    subscriptions.update('owner', first.id, { label: 'Renamed', enabled: true })
    expect(subscriptions.account(first.id)?.id).toBe(first.id)
    expect(() => subscriptions.assertLogin(sameToken.id, claude('replacement-token'))).not.toThrow()
  })

  it.each(['chatgpt_user_id', 'sub'] as const)(
    'distinguishes Business seats through stable %s identity',
    (claim) => {
      const first = subscriptions.create('owner', 'codex', 'First seat')
      const second = subscriptions.create('owner', 'codex', 'Second seat')
      const firstLogin = seatLogin('shared-business', 'seat-one', claim)
      const secondLogin = seatLogin('shared-business', 'seat-two', claim)
      subscriptions.assertLogin(first.id, firstLogin)()
      subscriptions.connected(first.id, firstLogin)
      expect(() => subscriptions.assertLogin(second.id, secondLogin)).not.toThrow()
      subscriptions.assertLogin(second.id, secondLogin)()
      subscriptions.connected(second.id, secondLogin)
      const alias = subscriptions.create('owner', 'codex', 'Renamed first seat')
      expect(() => subscriptions.assertLogin(alias.id, firstLogin)).toThrow(/already|duplicate/i)
      expect(() => subscriptions.assertLogin(first.id, secondLogin)).toThrow(
        /same.*subscription|same.*account/i
      )
      expect(() => subscriptions.assertLogin(first.id, codex('shared-business'))).toThrow(
        /same.*subscription|same.*account/i
      )
    }
  )

  it('does not count a missing Codex seat claim as independent capacity', () => {
    const unknown = connected('codex', 'shared-business')
    const known = subscriptions.create('owner', 'codex', 'Known seat')
    expect(() => subscriptions.assertLogin(known.id, seatLogin('shared-business', 'seat-one'))).toThrow(
      /already|duplicate/i
    )
    expect(() => subscriptions.assertLogin(unknown.id, codex('another-business'))).toThrow(
      /same.*subscription|same.*account/i
    )
  })

  it('preserves canonical refresh publication through availability changes while rejecting changed identity', () => {
    const account = subscriptions.create('owner', 'codex', 'Seat')
    const login = seatLogin('business', 'seat-one')
    subscriptions.assertLogin(account.id, login)()
    subscriptions.connected(account.id, login)
    const refreshing = subscriptions.guardRefresh(account.id, login)
    subscriptions.update('owner', account.id, { label: account.label, enabled: false })
    expect(refreshing).not.toThrow()
    subscriptions.disconnected(account.id)
    expect(refreshing).not.toThrow()
    expect(() => subscriptions.guardRefresh(account.id, seatLogin('business', 'seat-two'))).toThrow(
      /same.*subscription|same.*account/i
    )
    expect(() => subscriptions.guardRefresh(account.id, claude())).toThrow(/provider/i)
  })

  it('fences delayed account operations across disable/re-enable, disconnect, and duplicate publication races', () => {
    const account = subscriptions.create('owner', 'codex', 'First')
    const old = subscriptions.guardAccount(account.id)
    subscriptions.update('owner', account.id, { label: account.label, enabled: false })
    subscriptions.update('owner', account.id, { label: account.label, enabled: true })
    expect(old).toThrow(/changed|authorized|disabled/i)
    const pendingLogin = subscriptions.assertLogin(account.id, codex())
    subscriptions.disconnected(account.id)
    expect(pendingLogin).toThrow(/changed|authorized/i)
    const second = subscriptions.create('owner', 'codex', 'Second')
    const one = subscriptions.assertLogin(account.id, codex())
    const two = subscriptions.assertLogin(second.id, codex())
    one()
    expect(two).toThrow(/already|duplicate/i)
    subscriptions.connected(account.id, codex())
    expect(subscriptions.account(account.id)?.state).toBe('ready')
    expect(subscriptions.account(second.id)?.state).toBe('disconnected')
  })

  it('permits explicit disabled-account disconnect guards while fencing later lifecycle changes', () => {
    const account = connected('codex')
    subscriptions.update('owner', account.id, { label: account.label, enabled: false })
    expect(() => subscriptions.guardAccount(account.id)).toThrow(/authorized|disabled/i)
    expect(() => subscriptions.guardAccount(account.id, true)).not.toThrow()
    const beforeReenable = subscriptions.guardAccount(account.id, true)
    subscriptions.update('owner', account.id, { label: account.label, enabled: true })
    subscriptions.update('owner', account.id, { label: account.label, enabled: false })
    expect(beforeReenable).toThrow(/changed|authorized/i)
    const beforeDisconnect = subscriptions.guardAccount(account.id, true)
    subscriptions.disconnected(account.id)
    expect(beforeDisconnect).toThrow(/changed|authorized/i)
  })

  it('ignores authentication failures from an older credential after an owner reconnects', () => {
    const id = bot()
    const account = connected('codex')
    subscriptions.setGrant('owner', id, 'codex', true)
    pending(id, 'one')
    subscriptions.reserve(id, 'codex', 'one')
    const beforeReconnect = subscriptions.guardAccount(account.id)
    subscriptions.connected(account.id, codex(account.label))
    subscriptions.observe(id, 'codex', 'one', 401, {}, beforeReconnect)
    expect(subscriptions.assigned(id, 'codex', 'one')?.id).toBe(account.id)
  })

  it('shares canonical refresh refusal across bots without deleting identity or accepting stale failure', () => {
    const first = bot(),
      second = bot('second')
    const account = connected('codex')
    for (const id of [first, second]) subscriptions.setGrant('owner', id, 'codex', true)
    const old = subscriptions.guardAccount(account.id)
    subscriptions.connected(account.id, codex(account.label))
    subscriptions.authFailed(account.id, old)
    expect(subscriptions.available(first, 'codex')).toBe(true)
    subscriptions.authFailed(account.id, subscriptions.guardAccount(account.id))
    expect(subscriptions.available(first, 'codex')).toBe(false)
    expect(subscriptions.available(second, 'codex')).toBe(false)
    expect(subscriptions.account(account.id)).toMatchObject({ state: 'auth_failed', enabled: true })
    const alias = subscriptions.create('owner', 'codex', 'Alias')
    expect(() => subscriptions.assertLogin(alias.id, codex(account.label))).toThrow(/already|duplicate/i)
  })
})
