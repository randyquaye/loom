import type Database from 'better-sqlite3'
import { signInIsLive } from '../auth/tokens'
import { handle, type Caller } from '../ipc/registry'
import type { Logins } from '../logins/service'
import type { OrgService } from '../org/service'
import type { Subscriptions } from './repository'

interface SubscriptionHandlerOptions {
  db: Database.Database
  org: OrgService
  subscriptions: Subscriptions
  logins: Logins | null
  changed(botId: string, stop: boolean): Promise<void> | void
}

/** Owners connect organization capacity; bots receive grants, never provider logins. */
export function registerSubscriptionHandlers(options: SubscriptionHandlerOptions): void {
  const { db, org, subscriptions } = options
  function administrator(caller: Caller | undefined): string {
    if (caller === undefined) throw new Error('Sign in to the organization first')
    if (caller.signInId !== undefined && !signInIsLive({ db, isAdmitted: org.active }, caller.signInId))
      throw new Error('This administrator sign-in is no longer valid')
    org.requireOwner(caller.userId)
    return caller.userId
  }
  function account(caller: Caller | undefined, id: string) {
    administrator(caller)
    const value = subscriptions.account(id)
    if (value === null) throw new Error('Subscription account was not found')
    return value
  }
  function keeper(): Logins {
    if (options.logins === null) throw new Error('Subscriptions require the runner credential service')
    return options.logins
  }
  function guard(caller: Caller | undefined, id: string, allowDisabled = false): () => void {
    account(caller, id)
    const unchanged = subscriptions.guardAccount(id, allowDisabled)
    return () => {
      administrator(caller)
      unchanged()
    }
  }
  function audit(caller: Caller | undefined, action: string, id: string): void {
    const actor = administrator(caller)
    db.prepare('INSERT INTO org_admin_log(actor_id,action,subject,at,detail) VALUES (?,?,?,?,NULL)').run(
      actor,
      action,
      id,
      Date.now()
    )
  }
  async function stopAccount(id: string): Promise<void> {
    keeper().revokeAccess(id)
    const results = await Promise.allSettled(
      subscriptions.affectedBots(id).map(async (botId) => {
        keeper().revokeAccess(botId)
        await options.changed(botId, true)
      })
    )
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected')
      throw new Error('Subscription cleanup failed; affected bot access remains blocked', {
        cause: failed.reason
      })
  }

  handle('subscriptions:list', (_input, caller) => subscriptions.list(administrator(caller)))
  handle('subscriptions:create', ({ provider, label }, caller) =>
    subscriptions.create(administrator(caller), provider, label)
  )
  handle('subscriptions:update', async ({ accountId, label, enabled, expectedEnabled }, caller) => {
    const previous = account(caller, accountId)
    const next = subscriptions.update(administrator(caller), accountId, { label, enabled, expectedEnabled })
    if (previous.enabled && !enabled) await stopAccount(accountId)
    return next
  })
  handle('subscriptions:status', ({ accountId }, caller) => {
    account(caller, accountId)
    return keeper().status(accountId)
  })
  handle('subscriptions:grants', ({ botId }, caller) => subscriptions.grants(administrator(caller), botId))
  handle('subscriptions:setGrant', async ({ botId, provider, allowed }, caller) => {
    subscriptions.setGrant(administrator(caller), botId, provider, allowed)
    if (!allowed) {
      keeper().revokeAccess(botId)
      await options.changed(botId, true)
    } else await options.changed(botId, false)
  })
  handle('subscriptions:connectClaude', async ({ accountId, token }, caller) => {
    if (account(caller, accountId).provider !== 'claude') throw new Error('Choose a Claude subscription slot')
    const assertCurrent = guard(caller, accountId)
    await stopAccount(accountId)
    assertCurrent()
    audit(caller, 'subscription.connect.start', accountId)
    await keeper().connectClaude(accountId, token, assertCurrent)
  })
  handle('subscriptions:connectCodex', async ({ accountId }, caller) => {
    if (account(caller, accountId).provider !== 'codex') throw new Error('Choose a Codex subscription slot')
    const assertCurrent = guard(caller, accountId)
    await stopAccount(accountId)
    assertCurrent()
    audit(caller, 'subscription.connect.start', accountId)
    return keeper().connectCodex(accountId, assertCurrent)
  })
  handle('subscriptions:disconnect', async ({ accountId }, caller) => {
    const previous = account(caller, accountId)
    // End admission before waiting for physical resource cleanup or encrypted deletion.
    subscriptions.disconnected(accountId)
    const assertCurrent = guard(caller, accountId, true)
    await stopAccount(accountId)
    assertCurrent()
    audit(caller, 'subscription.disconnect', accountId)
    await keeper().disconnect(accountId, previous.provider, assertCurrent)
  })
}
