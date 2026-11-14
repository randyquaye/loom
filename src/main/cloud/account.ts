import type { CloudRunner } from '../../shared/ipc-contract'
import { isLoopbackHost } from '../auth/callback'
import type { RunnerAuth } from './client'
import { createCloudSession, type CloudSession } from './session'
import { httpBase, signInThroughBrowser, type Tokens } from './sign-in'
import { HostProofError } from './host-proof'
import { createRunnerTransport, readRunnerTrust } from './transport'
import type { RunnerTrust } from '../../shared/org'

const RUNNER_URL_KEY = 'cloud::runner-url'
/** One entry per runner: a refresh token is never read for an address other than its own. */
const REFRESH_TOKEN_PREFIX = 'cloud::refresh-token::'
/** Pre-proof releases stored arbitrary runner addresses; those sessions must sign in again. */
const VERIFIED_HOST_PREFIX = 'cloud::verified-host::'

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
  development?: boolean
}

export interface CloudAccount {
  runner(): CloudRunner
  /** Follows another runner, or none with null. Answers with the address as it was kept. */
  setRunner(url: string | null, expectedEmail?: string): Promise<CloudRunner>
  /** Resolves once the person has finished in the browser. Asking again starts over. */
  signIn(expectedEmail?: string): Promise<void>
  signOut(): Promise<void>
  join(code: string, expectedEmail?: string): Promise<CloudRunner>
  close(): void
}

function inviteFrom(code: string): { host: string; secret: string } {
  const prefix = 'loom-invite.v1.'
  try {
    if (!code.startsWith(prefix) || code.length > 4096) throw new Error()
    const value = JSON.parse(Buffer.from(code.slice(prefix.length), 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
    if (
      typeof value['host'] !== 'string' ||
      typeof value['secret'] !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value['secret'])
    )
      throw new Error()
    const host = new URL(value['host'])
    if (
      host.protocol !== 'https:' ||
      runnerAddress(value['host']) !== `wss://${host.host}` ||
      host.pathname !== '/' ||
      host.username ||
      host.password ||
      host.search ||
      host.hash
    )
      throw new Error()
    return { host: `https://${host.host}`, secret: value['secret'] }
  } catch {
    throw new Error('This is not a valid organization invite code')
  }
}

/** Parsing a code is local. No request happens until the person confirms its host. */
export function previewInvite(code: string): { host: string } {
  return { host: inviteFrom(code).host }
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
  const developerLoopback =
    options.development === true && fixed !== null && isLoopbackHost(new URL(fixed).hostname)
  if (devToken !== null && !developerLoopback) {
    throw new Error('A developer token is allowed only for a loopback runner in a development build')
  }
  let url = fixed ?? (await vault.getRaw(RUNNER_URL_KEY))
  let session: CloudSession | null = null
  let following: Following | null = null
  /** The sign-in waiting on the browser, if there is one. */
  let attempt: AbortController | null = null
  let changing: Promise<unknown> = Promise.resolve()

  function change<T>(operation: () => Promise<T>): Promise<T> {
    const next = changing.then(operation)
    changing = next.catch(() => {})
    return next
  }

  function start(initialTokens?: Tokens): void {
    if (url === null) return
    if (devToken !== null) {
      following = options.follow(url, {
        token: async () => devToken,
        transport: createRunnerTransport({ base: httpBase(url), trust: async () => null, development: true })
      })
      return
    }
    const key = `${REFRESH_TOKEN_PREFIX}${url}`
    const proofKey = `${VERIFIED_HOST_PREFIX}${url}`
    const localDevelopment = options.development === true && isLoopbackHost(new URL(url).hostname)
    const transport = createRunnerTransport({
      base: httpBase(url),
      trust: async () => readRunnerTrust(await vault.getRaw(proofKey)),
      ...(options.development === undefined ? {} : { development: options.development })
    })
    const current = createCloudSession({
      runnerUrl: url,
      store: {
        get: () => vault.getRaw(key),
        set: (token) => vault.setRaw(key, token),
        clear: () => vault.deleteRaw(key)
      },
      openBrowser: options.openBrowser,
      transport,
      ...(options.development === undefined ? {} : { development: options.development }),
      ...(initialTokens === undefined ? {} : { initialTokens })
    })
    session = current
    following = options.follow(url, {
      token: async () =>
        localDevelopment || readRunnerTrust(await vault.getRaw(proofKey)) !== null
          ? current.accessToken()
          : null,
      onRefused: () => current.invalidate(),
      transport
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

  function blockCurrentHost(address: string): Promise<void> {
    return change(async () => {
      if (address !== url) return
      following?.close()
      following = null
      const current = session
      session = null
      await vault.deleteRaw(`${VERIFIED_HOST_PREFIX}${address}`)
      await current?.signOut(false)
      start()
    })
  }

  function workEmail(address: string, input: string): string {
    const email = input.trim().toLowerCase()
    if (options.development === true && isLoopbackHost(new URL(address).hostname)) return email
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error('Enter your primary work email before signing in')
    return email
  }

  function trustMarker(address: string, trust: RunnerTrust | null | undefined): string | null {
    const verified = readRunnerTrust(JSON.stringify(trust) ?? null)
    if (verified !== null) return JSON.stringify(verified)
    if (options.development === true && isLoopbackHost(new URL(address).hostname)) return null
    throw new HostProofError('The runner did not provide a verified Workspace domain')
  }

  async function adopt(address: string, expectedEmail: string, inviteSecret?: string): Promise<CloudRunner> {
    const email = workEmail(address, expectedEmail)
    attempt?.abort(new Error('Signing in was started again'))
    const mine = new AbortController()
    attempt = mine
    try {
      const tokens = await signInThroughBrowser({
        base: httpBase(address),
        expectedEmail: email,
        openBrowser: options.openBrowser,
        signal: mine.signal,
        ...(inviteSecret === undefined ? {} : { inviteSecret }),
        ...(options.development === undefined ? {} : { development: options.development })
      })
      const marker = trustMarker(address, tokens.trust)
      return await change(async () => {
        mine.signal.throwIfAborted()
        const key = `${REFRESH_TOKEN_PREFIX}${address}`
        const proofKey = `${VERIFIED_HOST_PREFIX}${address}`
        const previousToken = await vault.getRaw(key)
        const previousProof = await vault.getRaw(proofKey)
        mine.signal.throwIfAborted()
        const previousUrl = url
        try {
          await vault.setRaw(key, tokens.refreshToken)
          mine.signal.throwIfAborted()
          if (marker === null) await vault.deleteRaw(proofKey)
          else await vault.setRaw(proofKey, marker)
          mine.signal.throwIfAborted()
          await vault.setRaw(RUNNER_URL_KEY, address)
          mine.signal.throwIfAborted()
        } catch (error) {
          if (previousToken === null) await vault.deleteRaw(key)
          else await vault.setRaw(key, previousToken)
          if (previousProof === null) await vault.deleteRaw(proofKey)
          else await vault.setRaw(proofKey, previousProof)
          if (previousUrl === null) await vault.deleteRaw(RUNNER_URL_KEY)
          else await vault.setRaw(RUNNER_URL_KEY, previousUrl)
          throw error
        }
        following?.close()
        following = null
        session = null
        url = address
        start(tokens)
        return runner()
      })
    } catch (error) {
      if (error instanceof HostProofError && attempt === mine) await blockCurrentHost(address)
      throw error
    } finally {
      if (attempt === mine) attempt = null
    }
  }

  start()

  return {
    runner,

    async setRunner(next, expectedEmail = '') {
      if (fixed !== null) throw new Error('The runner address is set by LOOM_RUNNER_URL')
      const address = next === null ? null : runnerAddress(next)
      if (address !== null) return adopt(address, expectedEmail)
      attempt?.abort(new Error('Cloud turned off'))
      return change(async () => {
        await vault.deleteRaw(RUNNER_URL_KEY)
        stop('The runner address changed')
        url = null
        return runner()
      })
    },

    async signIn(expectedEmail = '') {
      const current = session
      if (current === null) {
        throw new Error(
          url === null ? 'Set the runner address before signing in' : 'This runner takes a developer token'
        )
      }
      const address = url!
      const email = workEmail(address, expectedEmail)
      attempt?.abort(new Error('Signing in was started again'))
      const mine = new AbortController()
      attempt = mine
      try {
        const trust = await current.signIn(email, mine.signal)
        mine.signal.throwIfAborted()
        const marker = trustMarker(address, trust)
        await change(async () => {
          mine.signal.throwIfAborted()
          if (marker === null) await vault.deleteRaw(`${VERIFIED_HOST_PREFIX}${address}`)
          else await vault.setRaw(`${VERIFIED_HOST_PREFIX}${address}`, marker)
        })
        mine.signal.throwIfAborted()
      } catch (error) {
        if (error instanceof HostProofError && attempt === mine) await blockCurrentHost(address)
        throw error
      } finally {
        if (attempt === mine) attempt = null
      }
      following?.reconnect()
    },

    async signOut() {
      attempt?.abort(new Error('Signed out'))
      await change(async () => {
        const verified =
          url !== null && readRunnerTrust(await vault.getRaw(`${VERIFIED_HOST_PREFIX}${url}`)) !== null
        await session?.signOut(verified || developerLoopback)
      })
      // Does not wait for the runner to close the connection: it may not be reachable.
      following?.reconnect()
    },

    async join(code, expectedEmail = '') {
      if (fixed !== null) throw new Error('The runner address is set by LOOM_RUNNER_URL')
      const invite = inviteFrom(code)
      return adopt(runnerAddress(invite.host), expectedEmail, invite.secret)
    },

    close: () => stop('Loom is closing')
  }
}
