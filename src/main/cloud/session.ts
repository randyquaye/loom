import {
  httpBase,
  requestTokens,
  revokeRefreshToken,
  signInThroughBrowser,
  SignInRefusedError,
  type Tokens
} from './sign-in'
import type { RunnerTrust } from '../../shared/org'
import type { RunnerTransport } from './transport'

/** Where the refresh token rests between runs: the macOS Keychain. The window never sees it. */
export interface RefreshTokenStore {
  get(): Promise<string | null>
  set(token: string): Promise<void>
  clear(): Promise<void>
}

export interface CloudSessionOptions {
  /** ws:// or wss:// address of the runner. */
  runnerUrl: string
  store: RefreshTokenStore
  /** Opens a page in the person's own browser. */
  openBrowser(url: string): void
  now?: () => number
  development?: boolean
  initialTokens?: Tokens
  transport?: RunnerTransport
}

export interface CloudSession {
  signedIn(): Promise<boolean>
  /** Resolves once the person has finished in the browser; rejects if refused or abandoned. */
  signIn(expectedEmail: string, signal?: AbortSignal): Promise<RunnerTrust | null>
  signOut(contactRunner?: boolean): Promise<void>
  /** A token the runner will accept right now, renewed first when it has to be; null when signed out. */
  accessToken(): Promise<string | null>
  /** The runner refused the current access token; the next ask renews instead of reusing it. */
  invalidate(): void
}

/** Renew this long before the access token would stop working. */
const RENEW_MARGIN_MS = 60 * 1000

/**
 * The desktop's sign-in with a runner. The access token lives in memory only; the refresh
 * token is all that is kept. Renewal happens in one place: a refresh token may be used once,
 * and two renewals racing would look to the runner like theft and end the sign-in.
 */
export function createCloudSession(options: CloudSessionOptions): CloudSession {
  const base = httpBase(options.runnerUrl)
  const now = options.now ?? Date.now
  let access: { token: string; expiresAt: number } | null =
    options.initialTokens === undefined
      ? null
      : {
          token: options.initialTokens.accessToken,
          expiresAt: now() + options.initialTokens.expiresIn * 1000
        }
  let renewing: Promise<string | null> | null = null
  let generation = 0
  let writing: Promise<unknown> = Promise.resolve()

  function write<T>(operation: () => Promise<T>): Promise<T> {
    const next = writing.then(operation)
    writing = next.catch(() => {})
    return next
  }

  function keep(tokens: Tokens, mine: number, signal?: AbortSignal): Promise<string | null> {
    return write(async () => {
      if (mine !== generation || signal?.aborted) return null
      const previous = signal === undefined ? null : await options.store.get()
      if (mine !== generation || signal?.aborted) return null
      await options.store.set(tokens.refreshToken)
      if (signal?.aborted) {
        if (previous === null) await options.store.clear()
        else await options.store.set(previous)
        return null
      }
      if (mine !== generation) return null
      access = { token: tokens.accessToken, expiresAt: now() + tokens.expiresIn * 1000 }
      return tokens.accessToken
    })
  }

  async function renew(): Promise<string | null> {
    const mine = generation
    const refreshToken = await options.store.get()
    if (refreshToken === null || mine !== generation) return null
    try {
      return await keep(
        await requestTokens(
          base,
          { grant_type: 'refresh_token', refresh_token: refreshToken },
          options.transport
        ),
        mine
      )
    } catch (error) {
      // An unreachable runner is not a sign-out: the stored token is still good for later.
      if (!(error instanceof SignInRefusedError)) throw error
      await write(async () => {
        if (mine !== generation) return
        access = null
        await options.store.clear()
      })
      return null
    }
  }

  return {
    async signedIn() {
      return (await options.store.get()) !== null
    },

    async signIn(expectedEmail, signal) {
      const mine = ++generation
      renewing = null
      const tokens = await signInThroughBrowser({
        base,
        expectedEmail,
        openBrowser: options.openBrowser,
        ...(options.development === undefined ? {} : { development: options.development }),
        ...(signal === undefined ? {} : { signal })
      })
      signal?.throwIfAborted()
      if (mine !== generation) throw new Error('This sign-in was superseded')
      const kept = await keep(tokens, ++generation, signal)
      signal?.throwIfAborted()
      if (kept === null) throw new Error('This sign-in was superseded')
      return tokens.trust ?? null
    },

    async signOut(contactRunner = true) {
      generation++
      renewing = null
      access = null
      const refreshToken = await write(async () => {
        const previous = await options.store.get()
        await options.store.clear()
        return previous
      })
      // Revoking is what closes this sign-in's connections on the runner.
      if (contactRunner && refreshToken !== null)
        await revokeRefreshToken(base, refreshToken, options.transport).catch(() => {})
    },

    accessToken() {
      if (access !== null && access.expiresAt - RENEW_MARGIN_MS > now()) return Promise.resolve(access.token)
      if (renewing === null) {
        const pending = renew().finally(() => {
          if (renewing === pending) renewing = null
        })
        renewing = pending
      }
      return renewing
    },

    invalidate() {
      access = null
    }
  }
}
