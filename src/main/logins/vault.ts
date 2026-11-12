import { z } from 'zod'
import type { LoginProvider } from './stand-in'

const claudeLogin = z.object({
  provider: z.literal('claude'),
  accessToken: z.string().min(1),
  /** Milliseconds since 1970; absent when the token does not say. */
  expiresAt: z.number().optional()
})

const codexLogin = z.object({
  provider: z.literal('codex'),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().min(1),
  /** Which ChatGPT account the login is for. Not a secret; the server wants it on every call. */
  accountId: z.string().min(1),
  expiresAt: z.number().optional()
})

/** Only GitHub App user tokens are accepted; old pasted personal tokens require reconnecting. */
const githubLogin = z.object({
  provider: z.literal('github'),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number(),
  refreshExpiresAt: z.number(),
  account: z.string().min(1),
  installed: z.boolean(),
  clientId: z.string().min(1)
})

const login = z.discriminatedUnion('provider', [claudeLogin, codexLogin, githubLogin])

export type ClaudeLogin = z.infer<typeof claudeLogin>
export type CodexLogin = z.infer<typeof codexLogin>
export type GithubLogin = z.infer<typeof githubLogin>
export type Login = z.infer<typeof login>

/** The part of the runner's encrypted store the vault needs. */
export interface SealedStore {
  getRaw(key: string): Promise<string | null>
  setRaw(key: string, value: string): Promise<void>
  deleteRaw(key: string): Promise<void>
}

export interface LoginVault {
  get<P extends LoginProvider>(userId: string, provider: P): Promise<Extract<Login, { provider: P }> | null>
  put(userId: string, login: Login): Promise<void>
  remove(userId: string, provider: LoginProvider): Promise<void>
}

/**
 * Where each user's real agent logins are kept: in the runner's encrypted store, outside
 * every home folder and checkout, so nothing a workspace runs can read them. The store's
 * key lives off the data disk, and a copy of that disk alone gives a login to nobody.
 */
export function createLoginVault(store: SealedStore): LoginVault {
  const keyOf = (userId: string, provider: LoginProvider): string => `login::${userId}::${provider}`
  return {
    async get<P extends LoginProvider>(userId: string, provider: P) {
      const kept = await store.getRaw(keyOf(userId, provider))
      if (kept === null) return null
      let value: unknown
      try {
        value = JSON.parse(kept)
      } catch {
        return null
      }
      const parsed = login.safeParse(value)
      // Something unreadable is treated as no login: the person connects again.
      if (!parsed.success || parsed.data.provider !== provider) return null
      return parsed.data as Extract<Login, { provider: P }>
    },
    put: (userId, value) => store.setRaw(keyOf(userId, value.provider), JSON.stringify(login.parse(value))),
    remove: (userId, provider) => store.deleteRaw(keyOf(userId, provider))
  }
}
