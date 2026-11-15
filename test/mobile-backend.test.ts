import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { ensureUser } from '../src/main/db/repos/users'
import { createOrgService } from '../src/main/org/service'
import { createBotService } from '../src/main/bots/repository'
import { robotConfig } from '../src/shared/bots'
import { isDesktopCallback, isMobileCallback, isSignInCallback } from '../src/main/auth/callback'
import { signInRoutes } from '../src/main/auth/routes'
import { challengeOf, newVerifier } from '../src/main/auth/pkce'
import { exchangeCode, startSignIn, whoHolds } from '../src/main/auth/tokens'
import { dispatch, type Caller } from '../src/main/ipc/registry'
import { createAccess } from '../src/main/runner/access'
import { createMobileAccess, registerMobileDiscovery } from '../src/main/runner/mobile'
import { startRunner } from '../src/main/runner/runner'

const ios = 'dev.loom.app.ios:/oauth/callback'
const android = 'dev.loom.app.android:/oauth/callback'
const desktop = 'http://127.0.0.1:12345/callback'
const capabilities = ['bots.v1', 'mobile.v1']
const closers: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

function database() {
  const db = openDb(':memory:')
  closers.push(() => db.close())
  return db
}

function person(db: Database.Database, id: string) {
  ensureUser(db, { id, email: `${id}@example.com` })
}

function signIn(db: Database.Database, redirectUri: string, userId = 'owner'): Caller {
  person(db, userId)
  const verifier = newVerifier()
  const code = startSignIn(db, { userId, redirectUri, codeChallenge: challengeOf(verifier) })
  const pair = exchangeCode({ db, isAdmitted: () => true }, { code, redirectUri, codeVerifier: verifier })
  return { ...whoHolds({ db, isAdmitted: () => true }, pair.accessToken)!, capabilities }
}

describe('native callback acceptance', () => {
  it.each([ios, android])('accepts only the exact registered native URI: %s', (callback) => {
    expect(isMobileCallback(callback)).toBe(true)
    expect(isSignInCallback(callback)).toBe(true)
    expect(isDesktopCallback(callback)).toBe(false)
    for (const nearMiss of [
      callback.toUpperCase(),
      `${callback}/`,
      `${callback}?`,
      `${callback}#`,
      `${callback}?state=x`,
      callback.replace(':/', '://'),
      callback.replace('/oauth/', '/%6fauth/'),
      callback.replace('/callback', '/elsewhere'),
      callback.replace('dev.loom.app.', 'dev.attacker.')
    ])
      expect(isSignInCallback(nearMiss), nearMiss).toBe(false)
  })

  it('retains literal desktop loopback handling and rejects unsafe destinations', () => {
    for (const callback of [desktop, 'http://[::1]:4321/callback'])
      expect(isSignInCallback(callback)).toBe(true)
    for (const callback of [
      'http://localhost:1234/callback',
      'https://127.0.0.1:1234/callback',
      'http://127.0.0.1.attacker.com:1234/callback',
      'http://user@127.0.0.1:1234/callback',
      'http://127.0.0.1:1234/callback#',
      'https://loom.example.com/oauth/callback',
      'com.loom.ios:/oauth/callback',
      'com.loom.android:/oauth/callback'
    ])
      expect(isSignInCallback(callback), callback).toBe(false)
  })

  it.each([ios, android])(
    'round-trips browser OAuth while retaining PKCE and callback binding: %s',
    async (callback) => {
      const db = database()
      const org = createOrgService(db, {
        ownerEmail: 'owner@example.com',
        publicUrl: 'https://loom.example.com'
      })
      let googleState = ''
      const routes = signInRoutes({
        db,
        org,
        google: {
          authorizeUrl(input) {
            googleState = input.state
            return `https://accounts.google.com/auth?state=${input.state}`
          },
          identify: async () => ({
            subject: 'synthetic-google-owner',
            email: 'owner@example.com',
            emailVerified: true,
            hostedDomain: 'example.com',
            identityToken: 'synthetic-identity-evidence'
          })
        },
        isAdmitted: org.active,
        domains: ['example.com'],
        publicUrl: 'https://loom.example.com',
        stateSecret: Buffer.alloc(32, 7),
        onSignInEnded: () => {}
      })
      const verifier = newVerifier()
      const query = new URLSearchParams({
        redirect_uri: callback,
        code_challenge: challengeOf(verifier),
        state: 'original-state',
        nonce: 'n'.repeat(43)
      })
      const start = await routes.request(`/auth/start?${query}`)
      expect(start.status).toBe(302)
      const cookie = start.headers.get('set-cookie')!.split(';')[0]!
      const returned = await routes.request(`/auth/google/callback?code=google-code&state=${googleState}`, {
        headers: { cookie }
      })
      const location = new URL(returned.headers.get('location')!)
      expect(`${location.protocol}${location.pathname}`).toBe(callback)
      expect(location.searchParams.get('state')).toBe('original-state')
      const code = location.searchParams.get('code')!
      const exchange = (redirectUri: string, codeVerifier: string) =>
        routes.request('/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier
          })
        })
      expect((await exchange(desktop, verifier)).status).toBe(400)
      expect((await exchange(callback, newVerifier())).status).toBe(400)
      const accepted = await exchange(callback, verifier)
      expect(accepted.status).toBe(200)
      const tokens = (await accepted.json()) as { access_token: string }
      expect(whoHolds({ db, isAdmitted: org.active }, tokens.access_token)).not.toBeNull()
      expect((await exchange(callback, verifier)).status).toBe(400)
      expect(whoHolds({ db, isAdmitted: org.active }, tokens.access_token)).toBeNull()
    }
  )
})

describe('persisted mobile authority', () => {
  it.each([ios, android])('restricts mobile tokens without restricting desktop tokens: %s', (callback) => {
    const db = database()
    const policy = createMobileAccess(db)
    const mobile = signIn(db, callback)
    const computer = signIn(db, desktop)
    for (const channel of [
      'projects:list',
      'sessions:send',
      'sessions:answerQuestion',
      'workspaces:stop',
      'files:read'
    ])
      expect(() => policy.assertMayCall(mobile, channel)).not.toThrow()
    for (const channel of [
      'terminal:create',
      'env:list',
      'env:set',
      'logins:status',
      'org:members',
      'workspaces:remove',
      'git:restoreCheckpoint',
      'sessions:create',
      'future:unknown'
    ]) {
      expect(() => policy.assertMayCall(mobile, channel)).toThrow(/mobile/i)
      expect(() => policy.assertMayCall(computer, channel)).not.toThrow()
    }
    expect(policy.isDesktop(mobile)).toBe(false)
    expect(policy.isDesktop(computer)).toBe(true)
    expect(() => policy.assertMayCall({ userId: 'owner' }, 'terminal:create')).not.toThrow()
  })

  it('fails closed for unknown, mismatched and revoked sign-ins', () => {
    const db = database()
    const policy = createMobileAccess(db)
    const accepted = signIn(db, ios)
    for (const caller of [
      { userId: 'owner', signInId: 'missing' },
      { ...accepted, userId: 'different-user' }
    ]) {
      expect(() => policy.assertMayCall(caller, 'app:ping')).toThrow(/sign-in/i)
      expect(policy.isDesktop(caller)).toBe(false)
    }
    db.prepare('UPDATE sign_ins SET revoked_at=1 WHERE id=?').run(accepted.signInId)
    expect(() => policy.assertMayCall(accepted, 'app:ping')).toThrow(/sign-in/i)
  })

  it('keeps client authority independent of authorization-code retention and rejects unknown callback issuance', () => {
    const db = database()
    const policy = createMobileAccess(db)
    const mobile = signIn(db, ios)
    const computer = signIn(db, desktop)
    db.exec('DELETE FROM auth_codes')
    expect(() => policy.assertMayCall(mobile, 'env:list')).toThrow(/mobile/i)
    expect(() => policy.assertMayCall(mobile, 'sessions:send')).not.toThrow()
    expect(() => policy.assertMayCall(computer, 'env:list')).not.toThrow()
    expect(() => signIn(db, 'unregistered:/callback')).toThrow(/callback/i)
  })

  it('limits live data to mobile features without suppressing desktop streams', () => {
    const db = database()
    const policy = createMobileAccess(db)
    const mobile = signIn(db, ios)
    const computer = signIn(db, desktop)
    for (const channel of [
      'session:event',
      'session:activity',
      'session:queue',
      'session:title',
      'workspace:state',
      'workspaces:powerChanged',
      'bots:changed'
    ])
      expect(policy.mayReceive(mobile, channel)).toBe(true)
    for (const channel of ['terminal:data', 'terminal:exit', 'future:secret']) {
      expect(policy.mayReceive(mobile, channel)).toBe(false)
      expect(policy.mayReceive(computer, channel)).toBe(true)
    }
  })
})

describe('permission-scoped project discovery', () => {
  it('returns own and explicitly shared projects, preserves owner privacy, and observes revoked grants', () => {
    const db = database()
    for (const id of ['owner', 'viewer', 'other']) person(db, id)
    const org = createOrgService(db, {
      ownerEmail: 'owner@example.com',
      publicUrl: 'https://loom.example.com'
    })
    org.admitGoogle('owner', 'owner@example.com', '')
    for (const id of ['viewer', 'other'])
      db.prepare(
        "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES (?,'member','human','active',0)"
      ).run(id)
    const bots = createBotService({ db, org })
    const bot = bots.create('owner', 'robot', { ...robotConfig(), repositories: ['example/repo'] })
    bots.setGrant('owner', bot.id, 'viewer', 'view')
    for (const [projectId, ownerId] of [
      ['mine', 'viewer'],
      ['private', 'other'],
      ['shared', bot.id],
      ['owner-only', 'owner']
    ]) {
      db.prepare('INSERT INTO projects(id,name,repo_path,created_at) VALUES (?,?,?,0)').run(
        projectId,
        projectId,
        `https://github.com/example/${projectId}`
      )
      db.prepare(
        'INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id) VALUES (?,?,?,?,?,0,?)'
      ).run(`${projectId}-w`, projectId, projectId, 'main', `/fixture/${projectId}`, ownerId)
    }
    const access = createAccess(db, org.owner)
    registerMobileDiscovery(db, access)
    const visible = (userId: string, requested = capabilities) => {
      const caller = { userId, capabilities: requested }
      access.assertMayCall(caller, 'projects:list', undefined)
      return (dispatch('projects:list', undefined, caller) as Array<{ id: string }>)
        .map((row) => row.id)
        .sort()
    }
    expect(visible('viewer')).toEqual(['mine', 'shared'])
    expect(visible('owner')).toEqual(['owner-only', 'shared'])
    expect(visible('other')).toEqual(['private'])
    expect(() => visible('viewer', ['bots.v1'])).toThrow(/mobile|updat/i)
    expect(visible('viewer', ['mobile.v1'])).toEqual(['mine'])
    bots.setGrant('owner', bot.id, 'viewer', null)
    expect(visible('viewer')).toEqual(['mine'])
  })
})

describe('production runner mobile gate integration', () => {
  it('negotiates mobile capability and refuses privileged RPC, HTTP administration and forwarding', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'loom-mobile-'))
    closers.push(() => rm(dataDir, { recursive: true, force: true }))
    const seed = openDb(path.join(dataDir, 'loom.db'))
    person(seed, 'owner')
    const org = createOrgService(seed, {
      ownerEmail: 'owner@example.com',
      publicUrl: 'https://loom.example.com'
    })
    org.admitGoogle('owner', 'owner@example.com', '')
    const verifier = newVerifier()
    const code = startSignIn(seed, {
      userId: 'owner',
      redirectUri: ios,
      codeChallenge: challengeOf(verifier)
    })
    const pair = exchangeCode(
      { db: seed, isAdmitted: org.active },
      { code, redirectUri: ios, codeVerifier: verifier }
    )
    const desktopCode = startSignIn(seed, {
      userId: 'owner',
      redirectUri: desktop,
      codeChallenge: challengeOf(verifier)
    })
    const desktopPair = exchangeCode(
      { db: seed, isAdmitted: org.active },
      { code: desktopCode, redirectUri: desktop, codeVerifier: verifier }
    )
    seed.close()
    const keys = generateKeyPairSync('ed25519')
    const runner = await startRunner({
      dataDir,
      secretKey: Buffer.alloc(32, 5),
      devIdentities: [],
      host: '127.0.0.1',
      port: 0,
      placement: { checkout: 'clone', runtime: 'machine' },
      allowLocalRemotes: true,
      signIn: {
        google: { authorizeUrl: () => 'https://accounts.google.com', identify: async () => null },
        domains: ['example.com'],
        ownerEmail: 'owner@example.com',
        googleClientId: 'synthetic-client',
        signingKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        transportProofFile: path.join(dataDir, 'absent-transport-proof.json'),
        publicUrl: 'https://loom.example.com'
      }
    })
    closers.push(() => runner.close())
    const admin = (token: string) =>
      fetch(`http://127.0.0.1:${runner.port}/admin/drain`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    expect((await admin(pair.accessToken)).status).toBe(403)
    expect((await admin(desktopPair.accessToken)).status).toBe(200)
    const frames: Array<Record<string, unknown>> = []
    const headers = {
      authorization: `Bearer ${pair.accessToken}`,
      'x-loom-capabilities': capabilities.join(',')
    }
    const socket = new WebSocket(`ws://127.0.0.1:${runner.port}/v1/ws`, { headers })
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>))
    closers.push(() => socket.terminate())
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'hello', protocol: 6 }))
    await vi.waitFor(() => expect(frames[0]).toMatchObject({ type: 'hello', protocol: 6, capabilities }))
    socket.send(JSON.stringify({ type: 'call', id: 1, channel: 'env:list', input: {} }))
    await vi.waitFor(() =>
      expect(frames.find((frame) => frame.id === 1)).toMatchObject({
        ok: false,
        error: expect.stringMatching(/mobile/i)
      })
    )
    socket.send(JSON.stringify({ type: 'call', id: 2, channel: 'app:ping' }))
    await vi.waitFor(() =>
      expect(frames.find((frame) => frame.id === 2)).toMatchObject({ ok: true, value: 'pong' })
    )
    const forward = new WebSocket(`ws://127.0.0.1:${runner.port}/v1/forward/private/4321?protocol=6`, {
      headers
    })
    forward.on('error', () => {})
    closers.push(() => forward.terminate())
    const status = await new Promise<number>((resolve) => {
      forward.on('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode!)
      })
    })
    expect(status).toBe(401)
  })
})
