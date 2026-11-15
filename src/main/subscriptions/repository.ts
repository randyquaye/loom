import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  subscriptionLabelSchema,
  subscriptionProviderSchema,
  subscriptionUpdateSchema,
  type SubscriptionAccess,
  type SubscriptionAccount,
  type SubscriptionProvider
} from '../../shared/subscriptions'
import type { ClaudeLogin, CodexLogin } from '../logins/vault'
import type { OrgService } from '../org/service'

type ModelLogin = ClaudeLogin | CodexLogin
type ResponseHeaders = Record<string, string | string[] | undefined>
interface AccountRow extends Omit<SubscriptionAccount, 'enabled'> {
  enabled: number
  revision: number
}
const CURRENT_BINDING = `(EXISTS (
  SELECT 1 FROM workspaces w WHERE w.id=b.workspace_id AND w.owner_id=b.bot_id
) OR (NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id=b.workspace_id) AND EXISTS (
  SELECT 1 FROM bot_invocations i WHERE i.workspace_id=b.workspace_id AND i.bot_id=b.bot_id AND i.state='preparing'
)))`
// Archiving does not stop existing streams, so it affects load rather than revocation audiences.
const LOAD_BINDING = `(${CURRENT_BINDING} AND NOT EXISTS (
  SELECT 1 FROM workspaces w WHERE w.id=b.workspace_id AND w.archived<>0
))`
const COLUMNS = `a.id,a.provider,a.label,a.enabled,a.state,a.revision,
  a.retry_at AS retryAt,a.provider_reset_at AS providerResetAt,a.last_used_at AS lastUsedAt,
  (SELECT COUNT(*) FROM subscription_bindings b WHERE b.account_id=a.id AND ${LOAD_BINDING}) AS assignedWorkspaces`

export type Subscriptions = ReturnType<typeof createSubscriptions>
export class SubscriptionIdentityError extends Error {}

interface CodexIdentity {
  account: string
  seat: string | null
}

function codexSeat(idToken: string): string | null {
  try {
    const claims = JSON.parse(
      Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')
    ) as Record<string, unknown>
    const auth = claims['https://api.openai.com/auth']
    const user =
      auth !== null && typeof auth === 'object'
        ? (auth as Record<string, unknown>)['chatgpt_user_id']
        : undefined
    if (typeof user === 'string' && user !== '') return user
    return typeof claims['sub'] === 'string' && claims['sub'] !== '' ? claims['sub'] : null
  } catch {
    return null
  }
}

function codexIdentity(key: string): CodexIdentity {
  try {
    const value: unknown = JSON.parse(key)
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      (typeof value[1] === 'string' || value[1] === null)
    )
      return { account: value[0], seat: value[1] }
  } catch {
    // Existing plain account-id claims remain conservative unknown-seat identities.
  }
  return { account: key, seat: null }
}

/** Organization-owned credentials; bot grants reference capacity without owning a login. */
export function createSubscriptions({
  db,
  org,
  isBot,
  now = Date.now
}: {
  db: Database.Database
  org: OrgService
  isBot(id: string): boolean
  now?: () => number
}) {
  function row(id: string): AccountRow | null {
    return (
      (db.prepare(`SELECT ${COLUMNS} FROM subscription_accounts a WHERE a.id=?`).get(id) as
        AccountRow | undefined) ?? null
    )
  }
  function metadata(value: AccountRow): SubscriptionAccount {
    const recovered = value.state === 'rate_limited' && value.retryAt !== null && value.retryAt <= now()
    return {
      id: value.id,
      provider: value.provider,
      label: value.label,
      enabled: value.enabled === 1,
      state: recovered ? 'ready' : value.state,
      retryAt: recovered ? null : value.retryAt,
      providerResetAt: value.providerResetAt,
      lastUsedAt: value.lastUsedAt,
      assignedWorkspaces: value.assignedWorkspaces
    }
  }
  function account(id: string): SubscriptionAccount | null {
    const value = row(id)
    return value === null ? null : metadata(value)
  }
  function activeAccount(id: string): SubscriptionAccount | null {
    const value = account(id)
    return value?.enabled === true && value.state === 'ready' ? value : null
  }
  function requireAccount(id: string): AccountRow {
    const value = row(id)
    if (value === null) throw new Error('Subscription account was not found')
    return value
  }
  function audit(actor: string, action: string, subject: string, detail: unknown): void {
    db.prepare('INSERT INTO org_admin_log(actor_id,action,subject,at,detail) VALUES (?,?,?,?,?)').run(
      actor,
      action,
      subject,
      now(),
      JSON.stringify(detail)
    )
  }
  function requireBot(botId: string): void {
    const member = org.member(botId)
    if (
      !isBot(botId) ||
      member?.kind !== 'bot' ||
      member.state !== 'active' ||
      db.prepare('SELECT 1 FROM bots WHERE user_id=?').get(botId) === undefined
    )
      throw new Error('An active bot is required')
  }
  function permitted(botId: string, provider: SubscriptionProvider): boolean {
    const member = org.member(botId)
    return (
      isBot(botId) &&
      member?.kind === 'bot' &&
      member.state === 'active' &&
      db.prepare('SELECT 1 FROM bots WHERE user_id=? AND enabled=1').get(botId) !== undefined &&
      db
        .prepare('SELECT 1 FROM bot_subscription_grants WHERE bot_id=? AND provider=?')
        .get(botId, provider) !== undefined
    )
  }
  function ownsWorkspace(botId: string, workspaceId: string): boolean {
    const workspace = db.prepare('SELECT owner_id AS owner FROM workspaces WHERE id=?').get(workspaceId) as
      { owner: string | null } | undefined
    const invocation = db
      .prepare('SELECT bot_id AS owner,state FROM bot_invocations WHERE workspace_id=?')
      .get(workspaceId) as { owner: string; state: string } | undefined
    if (workspace !== undefined && workspace.owner !== botId) return false
    if (invocation !== undefined && invocation.owner !== botId) return false
    return workspace?.owner === botId || (invocation?.owner === botId && invocation.state === 'preparing')
  }
  function binding(botId: string, provider: SubscriptionProvider, workspaceId: string): string | null {
    if (!permitted(botId, provider) || !ownsWorkspace(botId, workspaceId)) return null
    const found = db
      .prepare(
        'SELECT account_id AS id FROM subscription_bindings WHERE workspace_id=? AND provider=? AND bot_id=?'
      )
      .get(workspaceId, provider, botId) as { id: string } | undefined
    return found?.id ?? null
  }
  /** Binding metadata is for profile identity and error descriptions, never execution admission. */
  function bound(
    botId: string,
    provider: SubscriptionProvider,
    workspaceId: string
  ): SubscriptionAccount | null {
    const id = binding(botId, provider, workspaceId)
    const value = id === null ? null : account(id)
    return value?.provider === provider ? value : null
  }
  function assigned(
    botId: string,
    provider: SubscriptionProvider,
    workspaceId: string
  ): SubscriptionAccount | null {
    const value = bound(botId, provider, workspaceId)
    return value?.enabled === true && value.state === 'ready' ? value : null
  }
  function candidates(provider: SubscriptionProvider): SubscriptionAccount[] {
    return (
      db
        .prepare(
          `SELECT ${COLUMNS} FROM subscription_accounts a WHERE a.provider=? ORDER BY assignedWorkspaces,a.last_used_at,a.created_at,a.id`
        )
        .all(provider) as AccountRow[]
    )
      .map(metadata)
      .filter((value) => value.enabled && value.state === 'ready')
  }
  function guardAccount(id: string, allowDisabled = false): () => void {
    const current = requireAccount(id)
    const assertCurrent = () => {
      const latest = row(id)
      if (latest === null || (!allowDisabled && latest.enabled !== 1) || latest.revision !== current.revision)
        throw new Error('Subscription account changed or is no longer authorized')
    }
    assertCurrent()
    return assertCurrent
  }
  function identity(login: ModelLogin): string {
    if (login.provider === 'codex') {
      if (typeof login.accountId !== 'string' || login.accountId.trim() === '')
        throw new Error('Codex must identify its subscription account')
      return JSON.stringify([login.accountId, codexSeat(login.idToken)])
    }
    if (typeof login.accessToken !== 'string' || login.accessToken === '')
      throw new Error('A Claude subscription token is required')
    return createHash('sha256').update(login.accessToken).digest('hex')
  }
  function assertIdentity(
    id: string,
    provider: SubscriptionProvider,
    key: string,
    requireClaim: boolean
  ): void {
    if (requireAccount(id).provider !== provider)
      throw new SubscriptionIdentityError('Subscription provider does not match this login')
    const claims = db
      .prepare('SELECT identity,account_id AS id FROM subscription_identities WHERE provider=?')
      .all(provider) as { identity: string; id: string }[]
    const own = claims.filter((value) => value.id === id)
    if (provider === 'codex') {
      const next = codexIdentity(key)
      const same = (value: { identity: string }) => {
        const before = codexIdentity(value.identity)
        return before.account === next.account && before.seat === next.seat
      }
      if ((requireClaim || own.length > 0) && !own.some(same))
        throw new SubscriptionIdentityError('Reconnect the same Codex subscription account for this slot')
      if (
        claims.some((value) => {
          if (value.id === id) return false
          const before = codexIdentity(value.identity)
          return (
            before.account === next.account &&
            (before.seat === null || next.seat === null || before.seat === next.seat)
          )
        })
      )
        throw new SubscriptionIdentityError(
          'This subscription account is already connected under another label'
        )
    } else {
      if (requireClaim && !own.some((value) => value.identity === key))
        throw new SubscriptionIdentityError('Reconnect the same subscription account for this slot')
      if (claims.some((value) => value.id !== id && value.identity === key))
        throw new SubscriptionIdentityError(
          'This subscription account is already connected under another label'
        )
    }
  }
  function guardRefresh(id: string, login: ModelLogin): () => void {
    const key = identity(login)
    const validate = () => assertIdentity(id, login.provider, key, true)
    validate()
    return validate
  }
  function assertLogin(id: string, login: ModelLogin): () => void {
    const assertCurrent = guardAccount(id)
    const key = identity(login)
    const validate = () => {
      assertCurrent()
      assertIdentity(id, login.provider, key, false)
    }
    validate()
    return () =>
      db.transaction(() => {
        validate()
        db.prepare(
          'INSERT OR IGNORE INTO subscription_identities(provider,identity,account_id) VALUES (?,?,?)'
        ).run(login.provider, key, id)
      })()
  }
  function authFailed(id: string, assertCurrent?: () => void): void {
    try {
      assertCurrent?.()
    } catch {
      return
    }
    db.prepare(
      "UPDATE subscription_accounts SET state='auth_failed',retry_at=NULL,provider_reset_at=NULL,revision=revision+1 WHERE id=? AND enabled=1 AND state IN ('ready','rate_limited')"
    ).run(id)
  }

  return {
    account,
    activeAccount,
    bound,
    assigned,
    guardAccount,
    guardRefresh,
    assertLogin,
    authFailed,
    isAccount: (id: string): boolean => row(id) !== null,
    list(actor: string): SubscriptionAccount[] {
      org.requireOwner(actor)
      return (
        db
          .prepare(`SELECT ${COLUMNS} FROM subscription_accounts a ORDER BY a.created_at,a.id`)
          .all() as AccountRow[]
      ).map(metadata)
    },
    create(actor: string, provider: SubscriptionProvider, label: string): SubscriptionAccount {
      return db.transaction(() => {
        org.requireOwner(actor)
        const family = subscriptionProviderSchema.parse(provider)
        const name = subscriptionLabelSchema.parse(label)
        const id = `subscription_${randomUUID()}`
        db.prepare('INSERT INTO subscription_accounts(id,provider,label,created_at) VALUES (?,?,?,?)').run(
          id,
          family,
          name,
          now()
        )
        audit(actor, 'subscription.create', id, { provider: family, label: name })
        return account(id)!
      })()
    },
    update(
      actor: string,
      id: string,
      input: { label: string; enabled: boolean; expectedEnabled?: boolean }
    ): SubscriptionAccount {
      return db.transaction(() => {
        org.requireOwner(actor)
        const before = requireAccount(id)
        const { expectedEnabled, ...patch } = input
        if (
          expectedEnabled !== undefined &&
          (typeof expectedEnabled !== 'boolean' || before.enabled !== Number(expectedEnabled))
        )
          throw new Error('Subscription account changed; reload before saving')
        const value = subscriptionUpdateSchema.parse(patch)
        db.prepare('UPDATE subscription_accounts SET label=?,enabled=?,revision=revision+? WHERE id=?').run(
          value.label,
          Number(value.enabled),
          Number(before.enabled !== Number(value.enabled)),
          id
        )
        audit(actor, 'subscription.update', id, value)
        return account(id)!
      })()
    },
    grants(actor: string, botId: string): SubscriptionAccess {
      org.requireOwner(actor)
      requireBot(botId)
      const providers = db
        .prepare('SELECT provider FROM bot_subscription_grants WHERE bot_id=?')
        .all(botId) as { provider: SubscriptionProvider }[]
      return {
        claude: providers.some((value) => value.provider === 'claude'),
        codex: providers.some((value) => value.provider === 'codex')
      }
    },
    setGrant(actor: string, botId: string, provider: SubscriptionProvider, allowed: boolean): void {
      db.transaction(() => {
        org.requireOwner(actor)
        requireBot(botId)
        subscriptionProviderSchema.parse(provider)
        if (typeof allowed !== 'boolean') throw new Error('Choose whether subscription capacity is granted')
        if (allowed)
          db.prepare('INSERT OR IGNORE INTO bot_subscription_grants(bot_id,provider) VALUES (?,?)').run(
            botId,
            provider
          )
        else
          db.prepare('DELETE FROM bot_subscription_grants WHERE bot_id=? AND provider=?').run(botId, provider)
        audit(actor, 'subscription.grant', botId, { provider, allowed })
      })()
    },
    available: (botId: string, provider: SubscriptionProvider): boolean =>
      permitted(botId, provider) && candidates(provider).length > 0,
    reserve(botId: string, provider: SubscriptionProvider, workspaceId: string): SubscriptionAccount {
      return db.transaction(() => {
        if (!permitted(botId, provider)) throw new Error('This bot has no active subscription capacity grant')
        if (!ownsWorkspace(botId, workspaceId)) throw new Error('The workspace is not reserved for this bot')
        const existing = db
          .prepare('SELECT account_id AS id FROM subscription_bindings WHERE workspace_id=? AND provider=?')
          .get(workspaceId, provider) as { id: string } | undefined
        if (existing !== undefined) {
          const value = assigned(botId, provider, workspaceId)
          if (value === null) throw new Error('The assigned subscription account is currently unavailable')
          return value
        }
        const value = candidates(provider)[0]
        if (value === undefined) throw new Error('No subscription account is currently available')
        db.prepare(
          'INSERT INTO subscription_bindings(workspace_id,provider,bot_id,account_id,created_at) VALUES (?,?,?,?,?)'
        ).run(workspaceId, provider, botId, value.id, now())
        db.prepare('UPDATE subscription_accounts SET last_used_at=? WHERE id=?').run(now(), value.id)
        return account(value.id)!
      })()
    },
    connected(id: string, login: ModelLogin): void {
      db.transaction(() => {
        assertLogin(id, login)()
        db.prepare(
          "UPDATE subscription_accounts SET state='ready',retry_at=NULL,provider_reset_at=NULL,revision=revision+1 WHERE id=?"
        ).run(id)
      })()
    },
    disconnected(id: string): void {
      requireAccount(id)
      db.prepare(
        "UPDATE subscription_accounts SET state='disconnected',retry_at=NULL,provider_reset_at=NULL,revision=revision+1 WHERE id=?"
      ).run(id)
    },
    observe(
      botId: string,
      provider: SubscriptionProvider,
      workspaceId: string,
      status: number,
      headers: ResponseHeaders,
      assertCurrent?: () => void
    ): void {
      try {
        assertCurrent?.()
      } catch {
        return
      }
      const id = binding(botId, provider, workspaceId)
      if (id === null || account(id)?.enabled !== true) return
      if (status === 401) {
        authFailed(id)
      } else if (status === 429) {
        const header = (name: string) => {
          const value = headers[name]
          return Array.isArray(value) ? value[0] : value
        }
        const retry = header('retry-after')
        const seconds = retry === undefined ? NaN : Number(retry)
        const retryAt =
          Number.isFinite(seconds) && seconds >= 0 ? now() + seconds * 1000 : Date.parse(retry ?? '')
        const resets = [
          'anthropic-ratelimit-unified-reset',
          'anthropic-ratelimit-requests-reset',
          'anthropic-ratelimit-tokens-reset',
          'x-ratelimit-reset'
        ].flatMap((name) => {
          const value = header(name)
          if (value === undefined) return []
          const numeric = Number(value)
          const at = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(value)
          return Number.isFinite(at) && at > now() ? [at] : []
        })
        const current = row(id)
        const knownReset =
          current?.state === 'rate_limited' && (current.retryAt ?? 0) > now() ? current.providerResetAt : null
        const observedReset = resets.length === 0 ? null : Math.max(...resets)
        const resetAt = observedReset ?? knownReset
        const until = Math.max(
          now() + 1000,
          Number.isFinite(retryAt) ? retryAt : (observedReset ?? now() + 60000),
          current?.retryAt ?? 0
        )
        db.prepare(
          "UPDATE subscription_accounts SET state='rate_limited',retry_at=?,provider_reset_at=? WHERE id=? AND state IN ('ready','rate_limited')"
        ).run(until, resetAt, id)
      }
    },
    affectedBots(accountId: string): string[] {
      return (
        db
          .prepare(
            `SELECT DISTINCT b.bot_id AS id FROM subscription_bindings b WHERE b.account_id=? AND ${CURRENT_BINDING} ORDER BY b.bot_id`
          )
          .all(accountId) as { id: string }[]
      ).map((value) => value.id)
    }
  }
}
