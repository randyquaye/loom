import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { LoginAttempt } from '../../shared/ipc-contract'
import { isDesktopCallback } from '../auth/callback'
import type { GithubClient } from './github'
import type { GithubLogin, LoginVault } from './vault'

interface Options {
  publicUrl: string
  client: GithubClient
  vault: LoginVault
  isAdmitted(userId: string): boolean
  onConnected(userId: string): Promise<void>
  /** Told why a connection failed, for the runner's log. Never a code, a claim or a token. */
  onFailed?(why: string): void
}

interface Pending {
  userId: string
  attempt: LoginAttempt
  state: string
  browser: string
  consumed: boolean
  /** Where the desktop that started this is listening, on its own machine. */
  desktop: string
  /** What GitHub gave, and the one-time claim that makes it the starting person's. */
  held: { claim: string; login: GithubLogin } | null
}

const COOKIE = 'loom.github'
const LIFETIME = 10 * 60 * 1000
const secret = () => randomBytes(32).toString('base64url')
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Connecting GitHub for a person's cloud workspaces. The browser that approves on GitHub is
 * not known to be the person who clicked Connect: a link can be passed on, and whoever opens
 * it would be handing their GitHub access to its sender. So GitHub's answer is only held
 * here, and the browser is sent on to the desktop that started, on a port of its own
 * machine, with a one-time claim. Only that desktop, signed in as that person, can then
 * make the login theirs. A link opened anywhere else ends on a machine where nothing claims.
 */
export function createGithubConnect(options: Options) {
  const routes = new Hono()
  const byUser = new Map<string, Pending>()
  const cookie = {
    httpOnly: true,
    secure: options.publicUrl.startsWith('https:'),
    sameSite: 'Lax' as const,
    path: '/auth/github'
  }
  function current(userId: string): Pending | undefined {
    const pending = byUser.get(userId)
    if (
      pending !== undefined &&
      pending.attempt.expiresAt < Date.now() &&
      pending.attempt.state === 'waiting'
    ) {
      pending.attempt = {
        ...pending.attempt,
        state: 'expired',
        message: 'GitHub authorization expired. Try again.'
      }
      pending.consumed = true
      pending.held = null
    }
    return pending
  }
  routes.get('/auth/github/start', (c) => {
    const id = c.req.query('attempt') ?? ''
    const pending = [...byUser.values()].find((value) => equal(value.attempt.id, id))
    if (
      pending === undefined ||
      current(pending.userId)?.attempt.state !== 'waiting' ||
      pending.consumed ||
      !options.isAdmitted(pending.userId)
    ) {
      return c.text('Start GitHub authorization again from Loom.', 400)
    }
    pending.browser = secret()
    pending.state = secret()
    setCookie(c, COOKIE, pending.browser, { ...cookie, maxAge: LIFETIME / 1000 })
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    return c.redirect(options.client.authorizeUrl(pending.state))
  })
  routes.get('/auth/github/callback', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Referrer-Policy', 'no-referrer')
    const state = c.req.query('state') ?? ''
    const browser = getCookie(c, COOKIE) ?? ''
    const pending = [...byUser.values()].find((value) => value.state !== '' && equal(value.state, state))
    if (
      pending === undefined ||
      pending.consumed ||
      pending.browser === '' ||
      !equal(pending.browser, browser) ||
      current(pending.userId)?.attempt.state !== 'waiting' ||
      !options.isAdmitted(pending.userId)
    ) {
      return c.text('This authorization did not start in this browser, or expired. Start again in Loom.', 400)
    }
    deleteCookie(c, COOKIE, cookie)
    pending.consumed = true
    try {
      const code = c.req.query('code')
      if (!code || c.req.query('error')) throw new Error('Authorization was not completed')
      const login = await options.client.exchange(code)
      if (
        byUser.get(pending.userId) !== pending ||
        current(pending.userId)?.attempt.state !== 'waiting' ||
        !options.isAdmitted(pending.userId)
      )
        throw new Error('Authorization was cancelled')
      pending.held = { claim: secret(), login }
      const desktop = new URL(pending.desktop)
      desktop.searchParams.set('claim', pending.held.claim)
      return c.redirect(desktop.toString())
    } catch (error) {
      // The person only needs to know it did not work. Why is for whoever runs the host:
      // a wrong client secret looks the same to the person as anything else.
      options.onFailed?.(error instanceof Error ? error.message : 'for a reason that was not an error')
      pending.attempt = {
        ...pending.attempt,
        state: 'failed',
        message: 'GitHub authorization could not be completed. Try again.'
      }
      return c.text('GitHub was not connected. Return to Loom and try again.', 400)
    }
  })
  return {
    routes,
    /** `desktop` is where the starting desktop listens for the browser to come back. */
    begin(userId: string, desktop: string): { url: string } {
      if (!options.isAdmitted(userId)) throw new Error('You are no longer allowed to use this runner')
      if (!isDesktopCallback(desktop)) {
        throw new Error('A GitHub connection can only return to a port on your own machine')
      }
      const id = secret()
      const url = `${options.publicUrl.replace(/\/$/, '')}/auth/github/start?attempt=${id}`
      byUser.set(userId, {
        userId,
        attempt: { id, state: 'waiting', url, expiresAt: Date.now() + LIFETIME },
        state: '',
        browser: '',
        consumed: false,
        desktop,
        held: null
      })
      return { url }
    },
    /** The starting desktop brings the claim its browser came back with; this makes the login theirs. */
    async finish(userId: string, claim: string): Promise<void> {
      const pending = current(userId)
      const held = pending?.held ?? null
      if (
        pending === undefined ||
        held === null ||
        pending.attempt.state !== 'waiting' ||
        !equal(held.claim, claim) ||
        !options.isAdmitted(userId)
      ) {
        throw new Error('There is no GitHub connection of yours to finish')
      }
      pending.held = null
      await options.vault.put(userId, held.login)
      await options.onConnected(userId)
      pending.attempt = { ...pending.attempt, state: 'connected' }
    },
    attempt: (userId: string) => current(userId)?.attempt,
    cancel: (userId: string) => {
      byUser.delete(userId)
    },
    close: () => byUser.clear()
  }
}
