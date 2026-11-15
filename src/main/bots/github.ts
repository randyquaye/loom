import { createHash, createPrivateKey, sign } from 'node:crypto'
import { z } from 'zod'
import type { GithubLogin, SealedStore } from '../logins/vault'

const credentials = z.object({
  appId: z.string().regex(/^[1-9]\d{0,19}$/),
  installationId: z.string().regex(/^[1-9]\d{0,19}$/),
  privateKey: z.string().min(1).max(32768)
})
export type BotGithubCredentials = z.infer<typeof credentials>

export interface BotGithubOptions {
  store: SealedStore
  isAdmitted(botId: string): boolean
  isBot(botId: string): boolean
  repositories(botId: string): readonly string[]
  onRevoked?(botId: string): void
  request?: typeof fetch
  now?: () => number
}

const PERMISSIONS = { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' }
const RENEW_BEFORE_MS = 5 * 60_000
const repository = /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function validate(input: unknown): BotGithubCredentials {
  const parsed = credentials.safeParse(input)
  if (!parsed.success) throw new Error('Enter valid GitHub App and installation credentials')
  try {
    const key = createPrivateKey(parsed.data.privateKey)
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new Error('Invalid key')
  } catch {
    throw new Error('The GitHub App private key must be an RSA key of at least 2048 bits')
  }
  return parsed.data
}

/** Host-only installation credentials; no installation token enters the personal OAuth vault. */
export function createBotGithub(options: BotGithubOptions) {
  const now = options.now ?? Date.now
  const request = options.request ?? fetch
  const revisions = new Map<string, number>()
  const writes = new Map<string, Promise<unknown>>()
  const cached = new Map<string, { fingerprint: string; login: GithubLogin }>()
  const pending = new Map<
    string,
    { fingerprint: string; controller: AbortController; promise: Promise<GithubLogin | null> }
  >()
  const keyOf = (botId: string) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(botId)) throw new Error('Invalid bot identity')
    return `user::${botId}::bot-github`
  }
  const revision = (botId: string) => revisions.get(botId) ?? 0
  const admitted = (botId: string) => options.isBot(botId) && options.isAdmitted(botId)

  function scopeOf(botId: string) {
    const refs = [...new Set(options.repositories(botId))].sort()
    if (
      refs.length === 0 ||
      refs.length > 500 ||
      refs.some((ref) => !repository.test(ref) || ['.', '..'].includes(ref.split('/')[1]!))
    )
      throw new Error('Configure valid GitHub repositories before connecting the bot installation')
    const owners = new Set(refs.map((ref) => ref.split('/')[0]!))
    if (owners.size !== 1) throw new Error('Bot repositories must belong to one GitHub installation owner')
    return { refs, owner: refs[0]!.split('/')[0]!, key: refs.join('\n') }
  }

  function invalidate(botId: string): void {
    revisions.set(botId, revision(botId) + 1)
    cached.delete(botId)
    pending.get(botId)?.controller.abort()
    pending.delete(botId)
    options.onRevoked?.(botId)
  }

  function serialized<T>(botId: string, task: () => Promise<T>): Promise<T> {
    const next = (writes.get(botId) ?? Promise.resolve()).catch(() => {}).then(task)
    writes.set(botId, next)
    void next
      .finally(() => {
        if (writes.get(botId) === next) writes.delete(botId)
      })
      .catch(() => {})
    return next
  }

  async function login(botId: string): Promise<GithubLogin | null> {
    if (!admitted(botId)) return null
    const scope = scopeOf(botId)
    const expected = revision(botId)
    const current = () => {
      try {
        return admitted(botId) && revision(botId) === expected && scopeOf(botId).key === scope.key
      } catch {
        return false
      }
    }
    await writes.get(botId)
    if (!current()) return null
    const kept = await options.store.getRaw(keyOf(botId))
    if (!current() || kept === null) return null
    let config: BotGithubCredentials
    try {
      config = validate(JSON.parse(kept))
    } catch {
      throw new Error('Reconnect the bot GitHub installation credentials')
    }
    const fingerprint = createHash('sha256').update(`${expected}\n${scope.key}\n${kept}`).digest('hex')
    const previous = cached.get(botId)
    if (previous?.fingerprint === fingerprint && previous.login.expiresAt - RENEW_BEFORE_MS > now())
      return previous.login
    const existing = pending.get(botId)
    if (existing?.fingerprint === fingerprint) return existing.promise
    const controller = new AbortController()
    const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const at = Math.floor(now() / 1000)
    const unsigned = `${jwtPart({ alg: 'RS256', typ: 'JWT' })}.${jwtPart({ iss: config.appId, iat: at - 60, exp: at + 540 })}`
    const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), config.privateKey).toString('base64url')}`

    async function json(path: string, body?: unknown): Promise<Record<string, unknown> | null> {
      if (!current()) return null
      let answer: Response
      try {
        answer = await request(`https://api.github.com${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${jwt}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'user-agent': 'Loom',
            'x-github-api-version': '2026-03-10'
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
        })
      } catch {
        if (!current()) return null
        throw new Error('GitHub could not verify the bot installation')
      }
      if (!current()) return null
      if (!answer.ok) throw new Error('GitHub refused the bot installation credentials or repository grants')
      let value: unknown
      try {
        value = await answer.json()
      } catch {
        if (!current()) return null
        throw new Error('GitHub returned an invalid installation response')
      }
      if (!current()) return null
      if (!record(value)) throw new Error('GitHub returned an invalid installation response')
      return value
    }

    async function mint(): Promise<GithubLogin | null> {
      // JWT repository lookups prove both owner and installation before using repository names.
      for (const ref of scope.refs) {
        const installation = await json(`/repos/${ref}/installation`)
        if (installation === null) return null
        if (
          String(installation['id']) !== config.installationId ||
          !record(installation['account']) ||
          String(installation['account']['login']).toLowerCase() !== scope.owner
        )
          throw new Error('A bot repository does not belong to the configured GitHub installation')
      }
      const answer = await json(`/app/installations/${config.installationId}/access_tokens`, {
        repositories: scope.refs.map((ref) => ref.split('/')[1]!),
        permissions: PERMISSIONS
      })
      if (answer === null) return null
      const granted = answer['permissions']
      const refs = answer['repositories']
      if (
        !record(granted) ||
        Object.keys(granted).length !== Object.keys(PERMISSIONS).length ||
        Object.entries(PERMISSIONS).some(([name, value]) => granted[name] !== value) ||
        !Array.isArray(refs) ||
        refs.length !== scope.refs.length ||
        refs
          .map((ref: unknown) => (record(ref) ? String(ref['full_name']).toLowerCase() : ''))
          .sort()
          .join('\n') !== scope.key
      )
        throw new Error('GitHub returned permissions or repositories outside the requested scope')
      const expiresAt = typeof answer['expires_at'] === 'string' ? Date.parse(answer['expires_at']) : NaN
      if (
        typeof answer['token'] !== 'string' ||
        answer['token'].length === 0 ||
        answer['token'].length > 16384 ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now() + 60_000 ||
        expiresAt > now() + 65 * 60_000
      )
        throw new Error('GitHub returned an invalid installation token or expiry')
      // Adapter only: these refresh fields never reach renewingVault or persistent token storage.
      const result: GithubLogin = {
        provider: 'github',
        accessToken: answer['token'],
        expiresAt,
        refreshToken: 'loom-installation-managed',
        refreshExpiresAt: expiresAt,
        clientId: `installation:${config.appId}`,
        account: scope.owner,
        installed: true
      }
      if (!current()) return null
      cached.set(botId, { fingerprint, login: result })
      return result
    }

    const entry = { fingerprint, controller, promise: Promise.resolve(null) as Promise<GithubLogin | null> }
    entry.promise = mint().finally(() => {
      if (pending.get(botId) === entry) pending.delete(botId)
    })
    pending.set(botId, entry)
    return entry.promise
  }

  return {
    async configure(botId: string, input: BotGithubCredentials, assertMayCommit?: () => void): Promise<void> {
      assertMayCommit?.()
      if (!admitted(botId)) throw new Error('An active bot is required for GitHub installation credentials')
      const config = validate(input)
      scopeOf(botId)
      keyOf(botId)
      invalidate(botId)
      const expected = revision(botId)
      const assertCurrent = () => {
        assertMayCommit?.()
        if (!admitted(botId) || revision(botId) !== expected)
          throw new Error('The bot GitHub configuration changed')
      }
      await serialized(botId, async () => {
        assertCurrent()
        await options.store.setRaw(keyOf(botId), JSON.stringify(config), assertCurrent)
        assertCurrent()
      })
    },
    async configured(botId: string): Promise<boolean> {
      if (!options.isBot(botId)) return false
      await writes.get(botId)
      return (await options.store.getRaw(keyOf(botId))) !== null
    },
    async remove(botId: string, assertMayCommit?: () => void): Promise<void> {
      assertMayCommit?.()
      invalidate(botId)
      await serialized(botId, () => options.store.deleteRaw(keyOf(botId), assertMayCommit))
    },
    login,
    invalidate
  }
}

export type BotGithub = ReturnType<typeof createBotGithub>
