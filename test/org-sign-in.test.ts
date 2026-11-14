import { generateKeyPairSync, verify } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { createOrgService } from '../src/main/org/service'
import { signInRoutes } from '../src/main/auth/routes'
import { createHostProof } from '../src/main/auth/host-proof'
import { googleClient, type GoogleClient } from '../src/main/auth/google'
import { challengeOf, newVerifier } from '../src/main/auth/pkce'
import { startSignIn } from '../src/main/auth/tokens'
import { ensureUser } from '../src/main/db/repos/users'

const nonce = 'n'.repeat(43)
const callback = 'http://127.0.0.1:1234/callback'
const publicUrl = 'https://loom.example.net'
const keys = generateKeyPairSync('ed25519')
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
let db: Database.Database
let org: ReturnType<typeof createOrgService>

const google: GoogleClient = {
  authorizeUrl: ({ state, nonce: sentNonce }) =>
    `https://accounts.google.com/auth?state=${state}&nonce=${sentNonce}`,
  identify: async ({ code }) =>
    code === 'google-code'
      ? {
          subject: 'google-owner',
          email: 'owner@example.com',
          emailVerified: true,
          hostedDomain: 'example.com',
          identityToken: 'google-identity-token'
        }
      : null
}
function app() {
  return signInRoutes({
    db,
    org,
    google,
    isAdmitted: org.active,
    domains: ['example.com'],
    publicUrl,
    stateSecret: Buffer.alloc(32, 9),
    onSignInEnded: () => {},
    hostProof: (value) => createHostProof(privateKey, publicUrl, value)
  })
}
function form(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields)
  }
}
beforeEach(() => {
  db = openDb(':memory:')
  org = createOrgService(db, { ownerEmail: 'owner@example.com', publicUrl })
})
afterEach(() => {
  db.close()
  vi.unstubAllGlobals()
})

describe('org sign-in proof', () => {
  function pendingCode() {
    ensureUser(db, { id: 'person', email: 'person@example.com' })
    ensureUser(db, { id: 'owner', email: 'owner@example.com' })
    org.admitGoogle('owner', 'owner@example.com', 'bootstrap')
    const verifier = newVerifier()
    const invite = org.createInvite('owner', 'person@example.com')
    const secret = (
      JSON.parse(Buffer.from(invite.code.slice('loom-invite.v1.'.length), 'base64url').toString()) as {
        secret: string
      }
    ).secret
    org.noteInvite(secret, challengeOf(verifier))
    const code = startSignIn(db, {
      userId: 'person',
      redirectUri: callback,
      codeChallenge: challengeOf(verifier),
      identityToken: 'google-identity-token',
      nonce,
      inviteId: org.admitGoogle('person', 'person@example.com', challengeOf(verifier))
    })
    return { code, verifier }
  }

  it('reveals proof before PKCE exchange without issuing tokens or consuming the pending code', async () => {
    const routes = app()
    const { code, verifier } = pendingCode()
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await routes.request('/auth/proof', form({ code, redirect_uri: callback }))
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        id_token: 'google-identity-token',
        host_proof: createHostProof(privateKey, publicUrl, nonce)
      })
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT used_at FROM auth_codes').get()).toEqual({ used_at: null })
    expect(org.member('person')).toBeNull()
    expect(org.invites('owner')[0]?.usedAt).toBeNull()
    // The code cannot be redeemed by a party who saw the proof response.
    expect(
      (
        await routes.request(
          '/auth/token',
          form({
            grant_type: 'authorization_code',
            code,
            redirect_uri: callback,
            code_verifier: `${verifier.slice(0, -1)}${verifier.endsWith('x') ? 'y' : 'x'}`
          })
        )
      ).status
    ).toBe(400)
    expect(db.prepare('SELECT used_at FROM auth_codes').get()).toEqual({ used_at: null })
  })

  it.each(['expired', 'used', 'revoked'] as const)('reveals no identity from a %s code', async (state) => {
    const { code } = pendingCode()
    if (state === 'expired') db.prepare('UPDATE auth_codes SET expires_at=0').run()
    if (state === 'used') db.prepare('UPDATE auth_codes SET used_at=1').run()
    if (state === 'revoked') db.prepare('UPDATE sign_ins SET revoked_at=1').run()
    const response = await app().request('/auth/proof', form({ code, redirect_uri: callback }))
    expect(response.status).toBe(400)
    expect(await response.json()).not.toHaveProperty('id_token')
  })

  it('refuses proof requests with an unknown code, different callback, or oversized body', async () => {
    const { code } = pendingCode()
    for (const fields of [
      { code: 'unknown', redirect_uri: callback },
      { code, redirect_uri: 'http://127.0.0.1:5678/callback' }
    ]) {
      const response = await app().request('/auth/proof', form(fields))
      expect(response.status).toBe(400)
      expect(await response.json()).not.toHaveProperty('id_token')
    }
    expect(
      (await app().request('/auth/proof', form({ code: 'x'.repeat(8192), redirect_uri: callback }))).status
    ).toBe(413)
  })

  it('passes the desktop nonce unchanged and returns the Google token and runner signature once', async () => {
    const routes = app()
    const verifier = newVerifier()
    const started = await routes.request(
      `/auth/start?${new URLSearchParams({ redirect_uri: callback, state: 'desktop-state', code_challenge: challengeOf(verifier), nonce })}`
    )
    const target = new URL(started.headers.get('location')!)
    expect(target.searchParams.get('nonce')).toBe(nonce)
    const back = await routes.request(
      `/auth/google/callback?code=google-code&state=${target.searchParams.get('state')}`,
      { headers: { cookie: started.headers.get('set-cookie')!.split(';')[0]! } }
    )
    const landed = new URL(back.headers.get('location')!)
    expect(landed.toString()).not.toContain('google-identity-token')
    const response = await routes.request(
      '/auth/token',
      form({
        grant_type: 'authorization_code',
        code: landed.searchParams.get('code')!,
        redirect_uri: callback,
        code_verifier: verifier
      })
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      id_token: string
      host_proof: { host: string; public_key: string; signature: string }
      refresh_token: string
    }
    expect(body.id_token).toBe('google-identity-token')
    expect(body.host_proof.host).toBe('loom.example.net')
    expect(
      verify(
        null,
        Buffer.from(JSON.stringify(['loom.host-proof.v1', 'loom.example.net', nonce])),
        keys.publicKey,
        Buffer.from(body.host_proof.signature, 'base64')
      )
    ).toBe(true)
    const renewed = await routes.request(
      '/auth/token',
      form({ grant_type: 'refresh_token', refresh_token: body.refresh_token })
    )
    expect(await renewed.json()).not.toHaveProperty('id_token')
    expect(db.prepare('SELECT identity_token, nonce FROM auth_codes').get()).toEqual({
      identity_token: null,
      nonce: null
    })
  })

  it('refuses a missing nonce before sending the browser to Google', async () => {
    const response = await app().request(
      `/auth/start?${new URLSearchParams({ redirect_uri: callback, state: 'desktop-state', code_challenge: challengeOf(newVerifier()) })}`
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })

  it('requires the same nonce in the identity received directly from Google', async () => {
    const now = Math.floor(Date.now() / 1000)
    const claims = {
      iss: 'https://accounts.google.com',
      aud: 'client',
      sub: 'subject',
      exp: now + 600,
      iat: now,
      email: 'owner@example.com',
      email_verified: true,
      hd: 'example.com',
      nonce
    }
    let received = claims
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id_token: `header.${Buffer.from(JSON.stringify(received)).toString('base64url')}.signature`
            })
          )
      )
    )
    const client = googleClient({ clientId: 'client', clientSecret: 'secret' })
    const identify = () =>
      client.identify({
        code: 'code',
        codeVerifier: 'verifier',
        redirectUri: `${publicUrl}/auth/google/callback`,
        nonce
      })
    expect(await identify()).toMatchObject({ subject: 'subject', email: 'owner@example.com' })
    received = { ...claims, nonce: 'other-nonce' }
    expect(await identify()).toBeNull()
  })
})
