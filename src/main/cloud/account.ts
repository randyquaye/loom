import type { CloudRunner } from '../../shared/ipc-contract'
import { isLoopbackHost } from '../auth/callback'
import type { RunnerAuth } from './client'
import { createCloudSession, type CloudSession } from './session'

const RUNNER_URL_KEY = 'cloud::runner-url'
/** One entry per runner: a refresh token is never read for an address other than its own. */
const REFRESH_TOKEN_PREFIX = 'cloud::refresh-token::'

/** The part of the Keychain-backed secret store the account needs. */
export interface Vault {
  getRaw(key: string): Promise<string | null>
  setRaw(key: string, value: string): Promise<void>
  deleteRaw(key: string): Promise<void>
}

/** A runner being followed. */
export interface Following {
  /** Tries the runner again now. */
  reconnect(): void
  close(): void
}

export interface CloudAccountOptions {
  vault: Vault
  /** LOOM_RUNNER_URL and LOOM_RUNNER_TOKEN: a developer's runner, which Settings cannot change. */
  environment: { url?: string | undefined; token?: string | undefined }
  /** Opens a page in the person's own browser. */
  openBrowser(url: string): void
  /** Starts following a runner. Until this is called, Loom is the local app it always was. */
  follow(url: string, auth: RunnerAuth): Following
}

export interface CloudAccount {
  runner(): CloudRunner
  /** Follows another runner, or none with null. Answers with the address as it was kept. */
  setRunner(url: string | null): Promise<CloudRunner>
  /** Resolves once the person has finished in the browser. Asking again starts over. */
  signIn(): Promise<void>
  signOut(): Promise<void>
  close(): void
}

/**
 * The address the desktop connects to, from what a person typed. A token travels with every
 * connection, so the address must be one where it cannot be read on the way: TLS, or this
 * machine itself. It is a host and port only; the desktop adds its own paths.
 */
export function runnerAddress(input: string): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Enter the runner address, such as wss://loom.example.com')
  }
  const secure = url.protocol === 'wss:' || url.protocol === 'https:'
  if (!secure && url.protocol !== 'ws:' && url.protocol !== 'http:') {
    throw new Error('A runner address starts with wss://')
  }
  if (!secure && !isLoopbackHost(url.hostname)) {
    throw new Error('A runner on another machine must be reached over wss://')
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('A runner address is a host and port only')
  }
  return `${secure ? 'wss' : 'ws'}://${url.host}`
}

/**
 * Which runner this desktop follows and its sign-in with it. This is the one place that
 * decides whether Loom reaches out at all: with no address, nothing here connects anywhere.
 */
export async function openCloudAccount(options: CloudAccountOptions): Promise<CloudAccount> {
  const { vault } = options
  const fixed = options.environment.url ? runnerAddress(options.environment.url) : null
  // A developer's token is for the developer's runner only, never for an address from Settings.
  const devToken = fixed === null ? null : options.environment.token || null
  let url = fixed ?? (await vault.getRaw(RUNNER_URL_KEY))
  let session: CloudSession | null = null
  let following: Following | null = null
  /** The sign-in waiting on the browser, if there is one. */
  let attempt: AbortController | null = null

  function start(): void {
    if (url === null) return
    if (devToken !== null) {
      following = options.follow(url, { token: async () => devToken })
      return
    }
    const key = `${REFRESH_TOKEN_PREFIX}${url}`
    const current = createCloudSession({
      runnerUrl: url,
      store: {
        get: () => vault.getRaw(key),
        set: (token) => vault.setRaw(key, token),
        clear: () => vault.deleteRaw(key)
      },
      openBrowser: options.openBrowser
    })
    session = current
    following = options.follow(url, {
      token: () => current.accessToken(),
      onRefused: () => current.invalidate()
    })
  }

  /** Only the connection ends. The sign-in stays, under its own runner's address, for a return. */
  function stop(why: string): void {
    attempt?.abort(new Error(why))
    following?.close()
    following = null
    session = null
  }

  function runner(): CloudRunner {
    return { url, fixed: fixed !== null, devToken: devToken !== null }
  }

  start()

  return {
    runner,

    async setRunner(next) {
      if (fixed !== null) throw new Error('The runner address is set by LOOM_RUNNER_URL')
      const address = next === null ? null : runnerAddress(next)
      if (address === url) return runner()
      if (address === null) await vault.deleteRaw(RUNNER_URL_KEY)
      else await vault.setRaw(RUNNER_URL_KEY, address)
      // Nothing is awaited between leaving one runner and following the next.
      stop('The runner address changed')
      url = address
      start()
      return runner()
    },

    async signIn() {
      const current = session
      if (current === null) {
        throw new Error(
          url === null ? 'Set the runner address before signing in' : 'This runner takes a developer token'
        )
      }
      attempt?.abort(new Error('Signing in was started again'))
      const mine = new AbortController()
      attempt = mine
      try {
        await current.signIn(mine.signal)
      } finally {
        if (attempt === mine) attempt = null
      }
      following?.reconnect()
    },

    async signOut() {
      attempt?.abort(new Error('Signed out'))
      await session?.signOut()
      // Does not wait for the runner to close the connection: it may not be reachable.
      following?.reconnect()
    },

    close: () => stop('Loom is closing')
  }
}
