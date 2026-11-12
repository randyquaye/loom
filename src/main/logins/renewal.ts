import { GithubAuthorizationRefused, type GithubClient } from './github'
import type { LoginProvider } from './stand-in'
import type { CodexLogin, Login, LoginVault } from './vault'

const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const RENEW_BEFORE_MS = 5 * 60 * 1000

export interface RenewalOptions {
  codexTokenUrl?: string
  github?: GithubClient
  now?: () => number
}

export function expiryOf(accessToken: string): number | null {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null
  } catch {
    return null
  }
}

class RenewalRefusedError extends Error {}

async function renewCodex(login: CodexLogin, tokenUrl: string): Promise<CodexLogin> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: login.refreshToken
    }),
    signal: AbortSignal.timeout(20000),
    redirect: 'error'
  })
  if (response.status >= 400 && response.status < 500) throw new RenewalRefusedError()
  if (!response.ok) throw new Error('Codex could not renew its login')
  const body = (await response.json()) as Record<string, unknown>
  const accessToken = body['access_token']
  if (typeof accessToken !== 'string' || accessToken === '')
    throw new Error('The renewal held no access token')
  const kept = (name: string, before: string): string =>
    typeof body[name] === 'string' && body[name] !== '' ? body[name] : before
  return {
    ...login,
    accessToken,
    refreshToken: kept('refresh_token', login.refreshToken),
    idToken: kept('id_token', login.idToken)
  }
}

/** All consumers share this wrapper, including host git, the proxy and Settings. */
export function renewingVault(vault: LoginVault, options: RenewalOptions = {}): LoginVault {
  const now = options.now ?? Date.now
  const refreshing = new Map<string, Promise<Login | null>>()
  const revisions = new Map<string, number>()
  const writes = new Map<string, Promise<unknown>>()
  const keyOf = (userId: string, provider: LoginProvider) => `${userId}:${provider}`
  function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (writes.get(key) ?? Promise.resolve()).catch(() => {}).then(task)
    writes.set(key, next)
    void next
      .finally(() => {
        if (writes.get(key) === next) writes.delete(key)
      })
      .catch(() => {})
    return next
  }
  async function renew(
    userId: string,
    login: Exclude<Login, { provider: 'claude' }>,
    revision: number
  ): Promise<Login | null> {
    let next: Login | null
    try {
      if (login.provider === 'github') {
        if (!options.github || login.clientId !== options.github.clientId || login.refreshExpiresAt <= now())
          throw new RenewalRefusedError()
        next = await options.github.renew(login)
      } else next = await renewCodex(login, options.codexTokenUrl ?? CODEX_TOKEN_URL)
    } catch (error) {
      if (!(error instanceof RenewalRefusedError || error instanceof GithubAuthorizationRefused))
        return vault.get(userId, login.provider)
      next = null
    }
    const key = keyOf(userId, login.provider)
    return serialized(key, async () => {
      const current = await vault.get(userId, login.provider)
      if ((revisions.get(key) ?? 0) !== revision || current?.refreshToken !== login.refreshToken)
        return current
      if (next === null) await vault.remove(userId, login.provider)
      else await vault.put(userId, next)
      return next
    })
  }
  return {
    ...vault,
    put(userId, login) {
      const key = keyOf(userId, login.provider)
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
      return serialized(key, () => vault.put(userId, login))
    },
    remove(userId, provider) {
      const key = keyOf(userId, provider)
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
      return serialized(key, () => vault.remove(userId, provider))
    },
    async get<P extends LoginProvider>(userId: string, provider: P) {
      type Kept = Extract<Login, { provider: P }> | null
      const login: Login | null = await vault.get(userId, provider)
      if (login === null || login.provider === 'claude') return login as Kept
      if (login.provider === 'github' && (!options.github || login.clientId !== options.github.clientId))
        return null
      const expiry = login.provider === 'codex' ? expiryOf(login.accessToken) : login.expiresAt
      if (expiry === null || expiry - RENEW_BEFORE_MS > now()) return login as Kept
      const key = keyOf(userId, provider)
      let shared = refreshing.get(key)
      if (shared === undefined) {
        shared = renew(userId, login, revisions.get(key) ?? 0).finally(() => refreshing.delete(key))
        refreshing.set(key, shared)
      }
      return (await shared) as Kept
    }
  }
}
