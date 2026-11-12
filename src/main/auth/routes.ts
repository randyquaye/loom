import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { userForEmail } from '../db/repos/users'
import { isDesktopCallback } from './callback'
import type { GoogleClient } from './google'
import { challengeOf, newVerifier } from './pkce'
import { exchangeCode, refreshTokens, revokeToken, SignInError, startSignIn, type TokenPair } from './tokens'

// Ported from Sentinel (google-auth.ts, oauth/authorize.ts, oauth/token.ts and
// oauth/revoke.ts at bee6e80). Sentinel signs a person into its own web app and has a consent
// page; Loom's browser step only passes through on its way back to the desktop.

export interface SignInRouteDeps {
  db: Database.Database
  google: GoogleClient
  /** The pilot list. Being in the company is not enough. */
  isAdmitted(email: string): boolean
  /** Google Workspace domains whose accounts may sign in at all. */
  domains: readonly string[]
  /** The runner's own https address, as the browser and Google see it. */
  publicUrl: string
  /** Signs the browser's sign-in state; from host configuration, never sent anywhere. */
  stateSecret: Buffer
  /** Told when a sign-in is revoked, so its open connections can be closed. */
  onSignInEnded(signInId: string): void
}

const STATE_COOKIE = 'loom.sign_in'
const STATE_COOKIE_PATH = '/auth'
const STATE_MAX_AGE_MS = 10 * 60 * 1000
/** The secret also derives other keys; the context keeps one signature from passing as another. */
const SIGNING_CONTEXT = 'loom.sign_in.state.v1'
const MAX_DESKTOP_STATE = 1024
/** BASE64URL(SHA-256(verifier)) is always 43 characters (RFC 7636 section 4.2). */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/

/** What the browser carries between leaving for Google and coming back. */
interface PendingSignIn {
  /** Loom's own exchange with Google. */
  googleState: string
  googleVerifier: string
  /** What the desktop asked for, to be honoured once Google has answered. */
  redirectUri: string
  codeChallenge: string
  desktopState: string
  startedAt: number
}

type OAuthError = 'invalid_request' | 'invalid_grant' | 'unsupported_grant_type'

export function signInRoutes(deps: SignInRouteDeps): Hono {
  const app = new Hono()
  const googleCallback = `${deps.publicUrl.replace(/\/$/, '')}/auth/google/callback`
  const cookieOptions = {
    httpOnly: true,
    secure: deps.publicUrl.startsWith('https:'),
    // Lax, not Strict: the cookie has to survive the top-level redirect back from Google.
    sameSite: 'Lax',
    path: STATE_COOKIE_PATH
  } as const

  function sign(encoded: string): string {
    return createHmac('sha256', deps.stateSecret).update(`${SIGNING_CONTEXT}.${encoded}`).digest('hex')
  }

  function sameText(a: string, b: string): boolean {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
  }

  /** The pending sign-in this browser started, if its cookie is ours, intact and recent. */
  function pendingFrom(cookie: string | undefined): PendingSignIn | null {
    const split = cookie?.lastIndexOf('.') ?? -1
    if (cookie === undefined || split <= 0) return null
    const encoded = cookie.slice(0, split)
    if (!sameText(sign(encoded), cookie.slice(split + 1))) return null
    try {
      const pending = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as PendingSignIn
      return Date.now() - pending.startedAt > STATE_MAX_AGE_MS ? null : pending
    } catch {
      return null
    }
  }

  function refuse(c: Context, reason: string): Response {
    return c.text(`Loom could not sign you in: ${reason}. Start again from the Loom app.`, 400)
  }

  /** Back to the desktop, which is waiting on its own port, with either a code or the reason. */
  function toDesktop(
    c: Context,
    pending: PendingSignIn,
    result: { code: string } | { error: string }
  ): Response {
    const target = new URL(pending.redirectUri)
    for (const [key, value] of Object.entries(result)) target.searchParams.set(key, value)
    target.searchParams.set('state', pending.desktopState)
    return c.redirect(target.toString())
  }

  // The desktop opens this in the system browser.
  app.get('/auth/start', (c) => {
    const redirectUri = c.req.query('redirect_uri') ?? ''
    const codeChallenge = c.req.query('code_challenge') ?? ''
    const desktopState = c.req.query('state') ?? ''
    if (!isDesktopCallback(redirectUri))
      return refuse(c, 'the sign-in can only return to the Loom app on this computer')
    if (
      !S256_CHALLENGE.test(codeChallenge) ||
      desktopState === '' ||
      desktopState.length > MAX_DESKTOP_STATE
    ) {
      return refuse(c, 'the request from the Loom app was incomplete')
    }
    const pending: PendingSignIn = {
      googleState: randomBytes(32).toString('base64url'),
      googleVerifier: newVerifier(),
      redirectUri,
      codeChallenge,
      desktopState,
      startedAt: Date.now()
    }
    const encoded = Buffer.from(JSON.stringify(pending), 'utf8').toString('base64url')
    setCookie(c, STATE_COOKIE, `${encoded}.${sign(encoded)}`, {
      ...cookieOptions,
      maxAge: STATE_MAX_AGE_MS / 1000
    })
    return c.redirect(
      deps.google.authorizeUrl({
        state: pending.googleState,
        codeChallenge: challengeOf(pending.googleVerifier),
        redirectUri: googleCallback
      })
    )
  })

  // Google sends the browser back here.
  app.get('/auth/google/callback', async (c) => {
    const pending = pendingFrom(getCookie(c, STATE_COOKIE))
    // One use, whatever the outcome.
    deleteCookie(c, STATE_COOKIE, cookieOptions)
    const code = c.req.query('code')
    const state = c.req.query('state')
    if (pending === null || state === undefined || !sameText(state, pending.googleState)) {
      return refuse(c, 'this is not the browser the sign-in started in, or it took too long')
    }
    if (code === undefined || c.req.query('error') !== undefined) {
      return toDesktop(c, pending, { error: 'access_denied' })
    }
    const person = await deps.google.identify({
      code,
      codeVerifier: pending.googleVerifier,
      redirectUri: googleCallback
    })
    const allowed =
      person !== null &&
      person.emailVerified &&
      person.hostedDomain !== null &&
      deps.domains.includes(person.hostedDomain) &&
      deps.isAdmitted(person.email)
    if (!allowed) return toDesktop(c, pending, { error: 'access_denied' })
    const loomCode = startSignIn(deps.db, {
      userId: userForEmail(deps.db, person.email),
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge
    })
    return toDesktop(c, pending, { code: loomCode })
  })

  /** A form body, with a field read as undefined when absent and null when repeated (RFC 6749 section 3.2). */
  async function formOf(c: Context): Promise<((name: string) => string | undefined | null) | null> {
    const type = c.req.header('Content-Type')?.toLowerCase() ?? ''
    if (!type.startsWith('application/x-www-form-urlencoded')) return null
    const fields = new URLSearchParams(await c.req.text())
    return (name) => {
      const values = fields.getAll(name)
      return values.length === 0 ? undefined : values.length === 1 ? values[0] : null
    }
  }

  function oauthError(c: Context, error: OAuthError, description: string): Response {
    return c.json({ error, error_description: description }, 400)
  }

  function tokenResponse(c: Context, pair: TokenPair): Response {
    return c.json({
      access_token: pair.accessToken,
      refresh_token: pair.refreshToken,
      token_type: 'Bearer',
      expires_in: pair.expiresIn
    })
  }

  // The desktop swaps its one-time code, and later its refresh token, for tokens.
  app.post('/auth/token', async (c) => {
    c.header('Cache-Control', 'no-store')
    const field = await formOf(c)
    if (field === null)
      return oauthError(c, 'invalid_request', 'Body must be application/x-www-form-urlencoded')
    const grantType = field('grant_type')
    const signIn = { db: deps.db, isAdmitted: deps.isAdmitted }
    try {
      if (grantType === 'authorization_code') {
        const code = field('code')
        const redirectUri = field('redirect_uri')
        const codeVerifier = field('code_verifier')
        if (!code || !redirectUri || !codeVerifier) {
          return oauthError(
            c,
            'invalid_request',
            'code, redirect_uri and code_verifier are required once each'
          )
        }
        return tokenResponse(c, exchangeCode(signIn, { code, redirectUri, codeVerifier }))
      }
      if (grantType === 'refresh_token') {
        const refreshToken = field('refresh_token')
        if (!refreshToken) return oauthError(c, 'invalid_request', 'refresh_token is required once')
        return tokenResponse(c, refreshTokens(signIn, refreshToken))
      }
    } catch (error) {
      if (error instanceof SignInError) return oauthError(c, 'invalid_grant', error.message)
      throw error
    }
    return grantType
      ? oauthError(c, 'unsupported_grant_type', 'Only authorization_code and refresh_token are supported')
      : oauthError(c, 'invalid_request', 'grant_type is required once')
  })

  // Signing out. Unknown tokens get the same answer, so this never says whether a token exists.
  app.post('/auth/revoke', async (c) => {
    c.header('Cache-Control', 'no-store')
    const field = await formOf(c)
    const token = field === null ? undefined : field('token')
    if (!token) return oauthError(c, 'invalid_request', 'token is required once, in a form body')
    const ended = revokeToken(deps.db, token)
    if (ended !== null) deps.onSignInEnded(ended)
    return c.body(null, 200)
  })

  return app
}
