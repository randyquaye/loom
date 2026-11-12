import {
  httpBase,
  requestTokens,
  revokeRefreshToken,
  signInThroughBrowser,
  SignInRefusedError,
  type Tokens
} from './sign-in'

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
}

export interface CloudSession {
  signedIn(): Promise<boolean>
  /** Resolves once the person has finished in the browser; rejects if refused or abandoned. */
  signIn(signal?: AbortSignal): Promise<void>
  signOut(): Promise<void>
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
  let access: { token: string; expiresAt: number } | null = null
  let renewing: Promise<string | null> | null = null

  async function keep(tokens: Tokens): Promise<string> {
    await options.store.set(tokens.refreshToken)
    access = { token: tokens.accessToken, expiresAt: now() + tokens.expiresIn * 1000 }
    return tokens.accessToken
  }

  async function forget(): Promise<void> {
    access = null
    await options.store.clear()
  }

  async function renew(): Promise<string | null> {
    const refreshToken = await options.store.get()
    if (refreshToken === null) return null
    try {
      return await keep(
        await requestTokens(base, { grant_type: 'refresh_token', refresh_token: refreshToken })
      )
    } catch (error) {
      // An unreachable runner is not a sign-out: the stored token is still good for later.
      if (!(error instanceof SignInRefusedError)) throw error
      await forget()
      return null
    }
  }

  return {
    async signedIn() {
      return (await options.store.get()) !== null
    },

    async signIn(signal) {
      await keep(
        await signInThroughBrowser({
          base,
          openBrowser: options.openBrowser,
          ...(signal === undefined ? {} : { signal })
        })
      )
    },

    async signOut() {
      const refreshToken = await options.store.get()
      await forget()
      // Revoking is what closes this sign-in's connections on the runner.
      if (refreshToken !== null) await revokeRefreshToken(base, refreshToken).catch(() => {})
    },

    accessToken() {
      if (access !== null && access.expiresAt - RENEW_MARGIN_MS > now()) return Promise.resolve(access.token)
      renewing ??= renew().finally(() => {
        renewing = null
      })
      return renewing
    },

    invalidate() {
      access = null
    }
  }
}
