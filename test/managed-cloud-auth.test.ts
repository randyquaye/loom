import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { openDb } from '../src/main/db'
import { signInRoutes } from '../src/main/auth/routes'
import type { GoogleIdentity } from '../src/main/auth/google'
import { challengeOf, newVerifier } from '../src/main/auth/pkce'
import { createOrgService } from '../src/main/org/service'

const publicUrl = 'https://pilot.loombox.xyz'
const callback = 'http://127.0.0.1:1234/callback'
const ownerEmail = 'owner@gmail.com'
let db: Database.Database
let org: ReturnType<typeof createOrgService>
let person: GoogleIdentity

beforeEach(() => {
  db = openDb(':memory:')
  org = createOrgService(db, { ownerEmail, publicUrl, mode: 'managed' })
  person = {
    subject: 'google-owner',
    email: ownerEmail,
    emailVerified: true,
    hostedDomain: null,
    identityToken: 'signed-google-token'
  }
})
afterEach(() => db.close())

function app() {
  return signInRoutes({
    mode: 'managed',
    db,
    org,
    google: {
      authorizeUrl: ({ state }) => `https://accounts.google.com/auth?state=${state}`,
      identify: async () => person
    },
    isAdmitted: org.active,
    domains: [],
    publicUrl,
    stateSecret: Buffer.alloc(32, 9),
    onSignInEnded: () => {}
  })
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  }
}

async function signIn(routes: ReturnType<typeof app>, verifier = newVerifier()) {
  const start = await routes.request(
    `/auth/managed/start?${new URLSearchParams({
      redirect_uri: callback,
      state: 'desktop-state',
      code_challenge: challengeOf(verifier),
      nonce: 'n'.repeat(43)
    })}`
  )
  expect(start.status).toBe(302)
  const google = new URL(start.headers.get('location')!)
  const returned = await routes.request(
    `/auth/google/callback?code=google-code&state=${google.searchParams.get('state')}`,
    { headers: { cookie: start.headers.get('set-cookie')!.split(';')[0]! } }
  )
  const result = new URL(returned.headers.get('location')!)
  return {
    result,
    exchange: () =>
      routes.request(
        '/auth/managed/token',
        form({
          grant_type: 'authorization_code',
          code: result.searchParams.get('code')!,
          redirect_uri: callback,
          code_verifier: verifier
        })
      )
  }
}

describe('personal Google sign-in', () => {
  it('creates the configured Gmail owner and issues a runner session after PKCE exchange', async () => {
    const attempt = await signIn(app())
    expect(attempt.result.searchParams.has('code')).toBe(true)
    const response = await attempt.exchange()
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('refresh_token')
    const owner = db.prepare('SELECT id, google_subject FROM users').get() as {
      id: string
      google_subject: string
    }
    expect(owner.google_subject).toBe('google-owner')
    expect(org.current(owner.id)?.role).toBe('owner')
    expect(org.members(owner.id)).toHaveLength(1)
  })

  it('does not let an arbitrary verified Gmail account claim an empty runner', async () => {
    person = { ...person, subject: 'outsider', email: 'someone@gmail.com' }
    const attempt = await signIn(app())
    expect(attempt.result.searchParams.get('error')).toBe('access_denied')
    expect(org.organization()).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 })
  })

  it('does not expose legacy sign-in or token routes on a managed runner', async () => {
    const routes = app()
    for (const route of ['start', 'proof', 'token', 'invite', 'revoke']) {
      const response = await routes.request(
        `/auth/${route}`,
        route === 'start' ? undefined : form({ grant_type: 'refresh_token', refresh_token: 'old-token' })
      )
      expect(response.status).toBe(404)
      expect(response.headers.get('location')).toBeNull()
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get()).toEqual({ n: 0 })
  })

  it('admits an invited Gmail identity once and refuses its session after removal', async () => {
    const routes = app()
    await (await signIn(routes)).exchange()
    const owner = db.prepare('SELECT id FROM users').get() as { id: string }
    const invitation = org.createInvite(owner.id, 'member@gmail.com')
    const { secret, mode } = JSON.parse(
      Buffer.from(invitation.code.slice('loom-invite.v1.'.length), 'base64url').toString()
    ) as { secret: string; mode?: string }
    expect(mode).toBe('managed')
    const verifier = newVerifier()
    const noted = await routes.request(
      '/auth/managed/invite',
      form({ invite_secret: secret, code_challenge: challengeOf(verifier) })
    )
    expect(noted.status).toBe(200)
    person = { ...person, subject: 'google-member', email: 'member@gmail.com' }
    const response = await (await signIn(routes, verifier)).exchange()
    expect(response.status).toBe(200)
    const tokens = (await response.json()) as { refresh_token: string }
    const member = db.prepare('SELECT id FROM users WHERE google_subject=?').get(person.subject) as {
      id: string
    }
    expect(org.member(member.id)?.role).toBe('member')
    expect(org.invites(owner.id)[0]?.usedAt).not.toBeNull()
    org.remove(owner.id, member.id)
    const refresh = await routes.request(
      '/auth/managed/token',
      form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
    )
    expect(refresh.status).toBe(400)
    expect((await signIn(routes)).result.searchParams.get('error')).toBe('access_denied')
  })

  it.each([
    { email: ownerEmail, emailVerified: false, hostedDomain: null },
    { email: 'owner@third-party.com', emailVerified: true, hostedDomain: null },
    { email: 'owner@example.com', emailVerified: true, hostedDomain: 'different.com' }
  ])('refuses identities without current Google email authority: %j', async (identity) => {
    person = { ...person, ...identity }
    expect((await signIn(app())).result.searchParams.get('error')).toBe('access_denied')
    expect(org.organization()).toBeNull()
  })
})
