import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import { challengeOf, VERIFIER_PATTERN } from './pkce'
import { isMobileCallback, isSignInCallback } from './callback'
import type { OrgService } from '../org/service'

// Ported from Sentinel (apps/api/src/routes/oauth/token.ts, revoke.ts and
// lib/oauth-api-token.ts at bee6e80), onto SQLite. Left behind: scopes, resources, client
// registration and the MCP token exchange. Each operation is one transaction, so a code is
// used and a token rotated either completely or not at all.

export const CODE_TTL_MS = 60 * 1000
export const ACCESS_TTL_MS = 60 * 60 * 1000
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

const PREFIX = { code: 'loom_code_', access: 'loom_at_', refresh: 'loom_rt_' } as const

export class SignInError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignInError'
  }
}

export interface SignInDeps {
  db: Database.Database
  /** Active membership, read on every use by durable user id. */
  isAdmitted(userId: string): boolean
  org?: OrgService | undefined
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
  /** Seconds until the access token stops working. */
  expiresIn: number
  /** Present only during the one-time code exchange, never on refresh. */
  identityToken?: string | undefined
  nonce?: string | undefined
}

/** Who a live access token stands for. */
export interface Holder {
  userId: string
  signInId: string
}

function hash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** 32 random bytes behind a prefix that says what it is. Only its hash is ever stored. */
function mint(kind: keyof typeof PREFIX): string {
  return `${PREFIX[kind]}${randomBytes(32).toString('base64url')}`
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function issuePair(db: Database.Database, signInId: string, now: number): TokenPair {
  const pair: TokenPair = {
    accessToken: mint('access'),
    refreshToken: mint('refresh'),
    expiresIn: ACCESS_TTL_MS / 1000
  }
  const insert = db.prepare(
    'INSERT INTO auth_tokens (id, sign_in_id, kind, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)'
  )
  insert.run(randomUUID(), signInId, 'access', hash(pair.accessToken), now + ACCESS_TTL_MS)
  insert.run(randomUUID(), signInId, 'refresh', hash(pair.refreshToken), now + REFRESH_TTL_MS)
  return pair
}

/** Ends a sign-in and with it every code and token that descends from it. */
export function revokeSignIn(db: Database.Database, signInId: string, now = Date.now()): void {
  db.prepare('UPDATE sign_ins SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, signInId)
}

/**
 * Records that a person has proven who they are, and returns the one-time code their desktop
 * will swap for tokens. The code is bound to where it is sent and to the desktop's challenge.
 */
export function startSignIn(
  db: Database.Database,
  input: {
    userId: string
    redirectUri: string
    codeChallenge: string
    inviteId?: string | null | undefined
    identityToken?: string | undefined
    nonce?: string | undefined
  },
  now = Date.now()
): string {
  if (!isSignInCallback(input.redirectUri)) throw new SignInError('Unregistered sign-in callback')
  const code = mint('code')
  const signInId = randomUUID()
  db.transaction(() => {
    db.prepare('UPDATE auth_codes SET identity_token = NULL, nonce = NULL WHERE expires_at <= ?').run(now)
    db.prepare('INSERT INTO sign_ins (id, user_id, created_at, client_kind) VALUES (?, ?, ?, ?)').run(
      signInId,
      input.userId,
      now,
      isMobileCallback(input.redirectUri) ? 'mobile' : 'desktop'
    )
    db.prepare(
      `INSERT INTO auth_codes (code_hash, sign_in_id, redirect_uri, code_challenge, expires_at, invite_id, identity_token, nonce)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      hash(code),
      signInId,
      input.redirectUri,
      input.codeChallenge,
      now + CODE_TTL_MS,
      input.inviteId ?? null,
      input.identityToken ?? null,
      input.nonce ?? null
    )
  })()
  return code
}

interface CodeRow {
  sign_in_id: string
  redirect_uri: string
  code_challenge: string
  expires_at: number
  used_at: number | null
  revoked_at: number | null
  email: string
  user_id: string
  invite_id: string | null
  identity_token: string | null
  nonce: string | null
}

/** Proof is safe to request before sending the PKCE verifier to a verified TLS peer. */
export function signInProof(
  db: Database.Database,
  input: { code: string; redirectUri: string },
  now = Date.now()
): { identityToken: string; nonce: string } {
  const row = db
    .prepare(
      `SELECT c.identity_token, c.nonce FROM auth_codes c
    JOIN sign_ins s ON s.id = c.sign_in_id
    WHERE c.code_hash = ? AND c.redirect_uri = ? AND c.used_at IS NULL
      AND c.expires_at > ? AND s.revoked_at IS NULL`
    )
    .get(hash(input.code), input.redirectUri, now) as
    { identity_token: string | null; nonce: string | null } | undefined
  if (row === undefined || row.identity_token === null || row.nonce === null)
    throw new SignInError('This sign-in proof is no longer available')
  return { identityToken: row.identity_token, nonce: row.nonce }
}

/** A refusal is decided inside the transaction and thrown after it, so what it wrote is kept. */
type Outcome = { pair: TokenPair } | { refusal: string }

function settle(outcome: Outcome): TokenPair {
  if ('refusal' in outcome) throw new SignInError(outcome.refusal)
  return outcome.pair
}

/** Swaps a one-time code for tokens. Proof of possession is checked before the code is spent. */
export function exchangeCode(
  deps: SignInDeps,
  input: { code: string; redirectUri: string; codeVerifier: string },
  now = Date.now()
): TokenPair {
  const { db } = deps
  return settle(
    db.transaction((): Outcome => {
      const row = db
        .prepare(
          `SELECT c.sign_in_id, c.redirect_uri, c.code_challenge, c.expires_at, c.used_at,
                  c.invite_id, c.identity_token, c.nonce, s.revoked_at, s.user_id, u.email
           FROM auth_codes c JOIN sign_ins s ON s.id = c.sign_in_id JOIN users u ON u.id = s.user_id
           WHERE c.code_hash = ?`
        )
        .get(hash(input.code)) as CodeRow | undefined
      if (row === undefined) return { refusal: 'Invalid sign-in code' }
      if (row.redirect_uri !== input.redirectUri) return { refusal: 'The callback address does not match' }
      if (
        !VERIFIER_PATTERN.test(input.codeVerifier) ||
        !sameText(challengeOf(input.codeVerifier), row.code_challenge)
      ) {
        // Seeing a code is not holding it: without the verifier it can be neither used nor burned.
        return { refusal: 'The sign-in code was not issued to this desktop' }
      }
      if (row.used_at !== null) {
        // Presented twice with valid proof: two parties hold it, so neither keeps what it bought.
        revokeSignIn(db, row.sign_in_id, now)
        return { refusal: 'The sign-in code was already used' }
      }
      if (row.expires_at <= now) return { refusal: 'The sign-in code has expired' }
      if (row.revoked_at !== null) {
        return { refusal: 'This sign-in is no longer valid' }
      }
      if (row.invite_id !== null) {
        if (deps.org === undefined) return { refusal: 'This runner cannot redeem organization invites' }
        deps.org.redeemInvite(row.invite_id, row.user_id, row.email, row.code_challenge, now)
      }
      if (!deps.isAdmitted(row.user_id)) throw new SignInError('This sign-in is no longer valid')
      db.prepare(
        'UPDATE auth_codes SET used_at = ?, identity_token = NULL, nonce = NULL WHERE code_hash = ?'
      ).run(now, hash(input.code))
      return {
        pair: {
          ...issuePair(db, row.sign_in_id, now),
          identityToken: row.identity_token ?? undefined,
          nonce: row.nonce ?? undefined
        }
      }
    })()
  )
}

interface RefreshRow {
  id: string
  sign_in_id: string
  expires_at: number
  used_at: number | null
  token_revoked_at: number | null
  sign_in_revoked_at: number | null
  user_id: string
}

/** Rotates: the old refresh token stops working as the new pair starts (RFC 9700 section 4.14). */
export function refreshTokens(deps: SignInDeps, refreshToken: string, now = Date.now()): TokenPair {
  const { db } = deps
  return settle(
    db.transaction((): Outcome => {
      const row = db
        .prepare(
          `SELECT t.id, t.sign_in_id, t.expires_at, t.used_at, t.revoked_at AS token_revoked_at,
                  s.revoked_at AS sign_in_revoked_at, s.user_id
           FROM auth_tokens t JOIN sign_ins s ON s.id = t.sign_in_id
           WHERE t.token_hash = ? AND t.kind = 'refresh'`
        )
        .get(hash(refreshToken)) as RefreshRow | undefined
      if (row === undefined) return { refusal: 'Invalid refresh token' }
      if (row.used_at !== null || row.token_revoked_at !== null) {
        // A rotated or revoked refresh token coming back means two parties hold it.
        revokeSignIn(db, row.sign_in_id, now)
        return { refusal: 'The refresh token was already used' }
      }
      if (row.expires_at <= now || row.sign_in_revoked_at !== null || !deps.isAdmitted(row.user_id)) {
        return { refusal: 'This sign-in is no longer valid' }
      }
      db.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ?').run(now, row.id)
      return { pair: issuePair(db, row.sign_in_id, now) }
    })()
  )
}

/**
 * RFC 7009. Holding the token is the proof. A refresh token is its sign-in's lifeline, so
 * revoking one ends the sign-in, whose id is returned for closing its open connections; an
 * access token ends alone. An unknown token is not an error and reveals nothing.
 */
export function revokeToken(db: Database.Database, token: string, now = Date.now()): string | null {
  return db.transaction((): string | null => {
    const row = db
      .prepare('SELECT id, kind, sign_in_id FROM auth_tokens WHERE token_hash = ?')
      .get(hash(token)) as { id: string; kind: 'access' | 'refresh'; sign_in_id: string } | undefined
    if (row === undefined) return null
    db.prepare('UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, row.id)
    if (row.kind !== 'refresh') return null
    revokeSignIn(db, row.sign_in_id, now)
    return row.sign_in_id
  })()
}

/** Whether a sign-in still stands: not revoked, and its user remains an active member. */
export function signInIsLive(deps: SignInDeps, signInId: string): boolean {
  const row = deps.db
    .prepare('SELECT s.user_id FROM sign_ins s WHERE s.id = ? AND s.revoked_at IS NULL')
    .get(signInId) as { user_id: string } | undefined
  return row !== undefined && deps.isAdmitted(row.user_id)
}

/** Checked when a connection opens. Null means: not signed in. */
export function whoHolds(deps: SignInDeps, accessToken: string, now = Date.now()): Holder | null {
  const row = deps.db
    .prepare(
      `SELECT s.user_id, s.id AS sign_in_id
       FROM auth_tokens t JOIN sign_ins s ON s.id = t.sign_in_id
       WHERE t.token_hash = ? AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > ?
         AND s.revoked_at IS NULL`
    )
    .get(hash(accessToken), now) as { user_id: string; sign_in_id: string } | undefined
  if (row === undefined || !deps.isAdmitted(row.user_id)) return null
  return { userId: row.user_id, signInId: row.sign_in_id }
}
