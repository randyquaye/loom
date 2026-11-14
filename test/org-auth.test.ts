import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { ensureUser, userForGoogle } from '../src/main/db/repos/users'
import { createOrgService } from '../src/main/org/service'
import { challengeOf, newVerifier } from '../src/main/auth/pkce'
import { exchangeCode, refreshTokens, startSignIn, whoHolds } from '../src/main/auth/tokens'

let db: Database.Database
let org: ReturnType<typeof createOrgService>
const callback = 'http://127.0.0.1:1234/callback'
const owner = { subject: 'google-owner', email: 'owner@example.com' }

beforeEach(() => {
  db = openDb(':memory:')
  org = createOrgService(db, { ownerEmail: owner.email, publicUrl: 'https://loom.example.net' })
})
afterEach(() => db.close())

function bootstrap() {
  const userId = userForGoogle(db, owner)
  org.admitGoogle(userId, owner.email, '')
  return userId
}

function invited(email = 'ada@example.com', subject = 'google-ada') {
  const ownerId = bootstrap()
  const { code, invite } = org.createInvite(ownerId, email)
  const secret = (JSON.parse(Buffer.from(code.split('.')[2]!, 'base64url').toString()) as { secret: string })
    .secret
  const verifier = newVerifier()
  const challenge = challengeOf(verifier)
  org.noteInvite(secret, challenge)
  const userId = userForGoogle(db, { email, subject })
  const inviteId = org.admitGoogle(userId, email, challenge)
  const signInCode = startSignIn(db, {
    userId,
    redirectUri: callback,
    codeChallenge: challenge,
    inviteId,
    identityToken: 'one-time-google-token',
    nonce: 'desktop-nonce'
  })
  return { ownerId, userId, invite, verifier, signInCode }
}

function redeem(input: ReturnType<typeof invited>, verifier = input.verifier) {
  return exchangeCode(
    { db, isAdmitted: org.active, org },
    {
      code: input.signInCode,
      redirectUri: callback,
      codeVerifier: verifier
    }
  )
}

describe('Google account ownership', () => {
  it('binds legacy users once and preserves their identity through an email rename', () => {
    ensureUser(db, { id: 'legacy', email: 'ada@example.com' })
    expect(userForGoogle(db, { subject: 'google-ada', email: 'ada@example.com' })).toBe('legacy')
    expect(userForGoogle(db, { subject: 'google-ada', email: 'new@example.com' })).toBe('legacy')
    expect(db.prepare('SELECT email FROM users WHERE id = ?').get('legacy')).toEqual({
      email: 'new@example.com'
    })
  })

  it('refuses a reused address rather than granting a different Google account its data', () => {
    const first = userForGoogle(db, { subject: 'first-account', email: 'ada@example.com' })
    expect(() => userForGoogle(db, { subject: 'replacement-account', email: 'ada@example.com' })).toThrow(
      /different Google account/
    )
    expect(userForGoogle(db, { subject: 'first-account', email: 'ada@example.com' })).toBe(first)
  })
})

describe('organization authority', () => {
  it('uses the org row as the bootstrap marker and never promotes the initial email again', () => {
    const entry = invited()
    redeem(entry)
    org.setRole(entry.ownerId, entry.userId, 'owner')
    org.setRole(entry.userId, entry.ownerId, 'member')
    org.admitGoogle(entry.ownerId, owner.email, '')
    expect(org.owner(entry.ownerId)).toBe(false)
  })

  it('refuses demotion or removal of the last active owner', () => {
    const id = bootstrap()
    expect(() => org.setRole(id, id, 'member')).toThrow(/last active owner/)
    expect(() => org.remove(id, id)).toThrow(/last active owner/)
  })

  it('denies admin calls to members and rolls back an action if its audit write fails', () => {
    const entry = invited()
    redeem(entry)
    expect(() => org.members(entry.userId)).toThrow(/owner/)
    db.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON org_admin_log BEGIN SELECT RAISE(ABORT, 'audit failed'); END"
    )
    expect(() => org.setRole(entry.ownerId, entry.userId, 'owner')).toThrow('audit failed')
    expect(org.owner(entry.userId)).toBe(false)
  })

  it('lets owners request early removal cleanup without rewriting when removal happened', () => {
    const entry = invited()
    redeem(entry)
    expect(() => org.requestPurge(entry.ownerId, entry.userId)).toThrow(/removed/i)
    expect(() => org.requestPurge(entry.userId, entry.ownerId)).toThrow(/owner/i)
    org.remove(entry.ownerId, entry.userId)
    const removedAt = org.member(entry.userId)?.removedAt
    expect(org.dueRemoved()).toHaveLength(0)
    const requested = org.requestPurge(entry.ownerId, entry.userId)
    expect(requested.removedAt).toBe(removedAt)
    expect(requested.purgeStartedAt).toEqual(expect.any(Number))
    expect(org.dueRemoved().map((row) => row.userId)).toEqual([entry.userId])
    expect(org.adminLog(entry.ownerId)[0]).toMatchObject({
      action: 'member.purge.request',
      actorId: entry.ownerId,
      subject: entry.userId
    })
  })

  it('rolls back a purge request when its audit row cannot be stored', () => {
    const entry = invited()
    redeem(entry)
    org.remove(entry.ownerId, entry.userId)
    db.exec(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON org_admin_log BEGIN SELECT RAISE(ABORT, 'audit failed'); END"
    )
    expect(() => org.requestPurge(entry.ownerId, entry.userId)).toThrow('audit failed')
    expect(org.member(entry.userId)?.purgeStartedAt).toBeNull()
    expect(org.dueRemoved()).toHaveLength(0)
  })
})

describe('invite and sign-in transactions', () => {
  it('refuses a new invite for an already active member', () => {
    const entry = invited()
    redeem(entry)
    expect(() => org.createInvite(entry.ownerId, 'ADA@example.com')).toThrow(/active member/i)
  })

  it('consumes a previously made invite without demoting its now-active owner', () => {
    const entry = invited()
    const second = org.createInvite(entry.ownerId, 'ada@example.com')
    redeem(entry)
    org.setRole(entry.ownerId, entry.userId, 'owner')
    const secret = (
      JSON.parse(Buffer.from(second.code.split('.')[2]!, 'base64url').toString()) as { secret: string }
    ).secret
    const verifier = newVerifier()
    const codeChallenge = challengeOf(verifier)
    org.noteInvite(secret, codeChallenge)
    const inviteId = org.admitGoogle(entry.userId, 'ada@example.com', codeChallenge)
    expect(inviteId).toBe(second.invite.id)
    const code = startSignIn(db, { userId: entry.userId, redirectUri: callback, codeChallenge, inviteId })
    exchangeCode({ db, isAdmitted: org.active, org }, { code, redirectUri: callback, codeVerifier: verifier })
    expect(org.owner(entry.userId)).toBe(true)
    expect(org.member(entry.userId)?.kind).toBe('human')
    expect(org.invites(entry.ownerId).find((row) => row.id === second.invite.id)?.usedAt).toEqual(
      expect.any(Number)
    )
  })

  it('keeps an invite usable until valid PKCE proof, then admits exactly one member', () => {
    const entry = invited()
    expect(org.active(entry.userId)).toBe(false)
    expect(() => redeem(entry, newVerifier())).toThrow(/desktop/)
    expect(org.invites(entry.ownerId)[0]?.usedAt).toBeNull()
    const tokens = redeem(entry)
    expect(org.active(entry.userId)).toBe(true)
    expect(tokens.identityToken).toBe('one-time-google-token')
    expect(db.prepare('SELECT identity_token FROM auth_codes').get()).toEqual({ identity_token: null })
    expect(() => redeem(entry)).toThrow(/already used/)
    expect(org.members(entry.ownerId).filter((row) => row.userId === entry.userId)).toHaveLength(1)
  })

  it('checks revocation again at exchange and never spends the invite on refusal', () => {
    const entry = invited()
    org.revokeInvite(entry.ownerId, entry.invite.id)
    expect(() => redeem(entry)).toThrow(/invite/i)
    expect(org.active(entry.userId)).toBe(false)
    expect(org.invites(entry.ownerId)[0]?.usedAt).toBeNull()
  })

  it('admits one member when two completed browser attempts redeem the same invite', () => {
    const entry = invited()
    const { code } = org.createInvite(entry.ownerId, 'other@example.com')
    const secret = (
      JSON.parse(Buffer.from(code.split('.')[2]!, 'base64url').toString()) as { secret: string }
    ).secret
    const userId = userForGoogle(db, { subject: 'other-google', email: 'other@example.com' })
    const attempts = [newVerifier(), newVerifier()].map((verifier) => {
      const codeChallenge = challengeOf(verifier)
      org.noteInvite(secret, codeChallenge)
      const inviteId = org.admitGoogle(userId, 'other@example.com', codeChallenge)
      return { verifier, code: startSignIn(db, { userId, redirectUri: callback, codeChallenge, inviteId }) }
    })
    const exchange = (index: number) => {
      const attempt = attempts[index]!
      return exchangeCode(
        { db, isAdmitted: org.active, org },
        { code: attempt.code, redirectUri: callback, codeVerifier: attempt.verifier }
      )
    }
    expect(exchange(0).accessToken).toBeTruthy()
    expect(() => exchange(1)).toThrow(/invite/i)
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM auth_tokens t JOIN sign_ins s ON s.id = t.sign_in_id WHERE s.user_id = ?'
        )
        .get(userId)
    ).toEqual({ n: 2 })
    expect(org.members(entry.ownerId).filter((row) => row.userId === userId)).toHaveLength(1)
  })

  it('rolls back membership and invite use if token issuance fails', () => {
    const entry = invited()
    db.exec(
      "CREATE TRIGGER reject_token BEFORE INSERT ON auth_tokens BEGIN SELECT RAISE(ABORT, 'token storage failed'); END"
    )
    expect(() => redeem(entry)).toThrow('token storage failed')
    expect(org.active(entry.userId)).toBe(false)
    expect(org.invites(entry.ownerId)[0]?.usedAt).toBeNull()
    db.exec('DROP TRIGGER reject_token')
    expect(redeem(entry).accessToken).toBeTruthy()
  })

  it('keeps a rejoin waiting while expired retained files are being purged', () => {
    const entry = invited()
    redeem(entry)
    org.remove(entry.ownerId, entry.userId)
    db.prepare('UPDATE org_members SET removed_at = 0 WHERE user_id = ?').run(entry.userId)
    const { code } = org.createInvite(entry.ownerId, 'ada@example.com')
    const secret = (
      JSON.parse(Buffer.from(code.split('.')[2]!, 'base64url').toString()) as { secret: string }
    ).secret
    const verifier = newVerifier()
    const codeChallenge = challengeOf(verifier)
    org.noteInvite(secret, codeChallenge)
    const inviteId = org.admitGoogle(entry.userId, 'ada@example.com', codeChallenge)
    const fresh = startSignIn(db, { userId: entry.userId, redirectUri: callback, codeChallenge, inviteId })
    const exchange = () =>
      exchangeCode(
        { db, isAdmitted: org.active, org },
        { code: fresh, redirectUri: callback, codeVerifier: verifier }
      )
    expect(exchange).toThrow(/cleanup pending/i)
    org.markPurged(entry.userId)
    expect(exchange().accessToken).toBeTruthy()
  })

  it('blocks rejoining after an early purge request until file deletion completes', () => {
    const entry = invited()
    redeem(entry)
    org.remove(entry.ownerId, entry.userId)
    org.requestPurge(entry.ownerId, entry.userId)
    const { code } = org.createInvite(entry.ownerId, 'ada@example.com')
    const secret = (
      JSON.parse(Buffer.from(code.split('.')[2]!, 'base64url').toString()) as { secret: string }
    ).secret
    const verifier = newVerifier()
    const codeChallenge = challengeOf(verifier)
    org.noteInvite(secret, codeChallenge)
    const inviteId = org.admitGoogle(entry.userId, 'ada@example.com', codeChallenge)
    const fresh = startSignIn(db, { userId: entry.userId, redirectUri: callback, codeChallenge, inviteId })
    const exchange = () =>
      exchangeCode(
        { db, isAdmitted: org.active, org },
        { code: fresh, redirectUri: callback, codeVerifier: verifier }
      )
    expect(exchange).toThrow(/cleanup pending/i)
    org.markPurged(entry.userId)
    expect(exchange().accessToken).toBeTruthy()
    expect(org.member(entry.userId)?.purgeStartedAt).toBeNull()
  })

  it('rejects a wrong email and an expired invite before making membership', () => {
    const entry = invited()
    expect(() => org.admitGoogle('someone', 'other@example.com', challengeOf(entry.verifier))).toThrow(
      /invite/i
    )
    db.prepare('UPDATE org_invites SET expires_at = 0').run()
    expect(() => redeem(entry)).toThrow(/invite/i)
  })

  it('does not revive removed sign-ins when the same Google account joins again', () => {
    const entry = invited()
    const first = redeem(entry)
    expect(org.remove(entry.ownerId, entry.userId)).toHaveLength(1)
    expect(whoHolds({ db, isAdmitted: org.active }, first.accessToken)).toBeNull()
    const { code } = org.createInvite(entry.ownerId, 'ada@example.com')
    const secret = (
      JSON.parse(Buffer.from(code.split('.')[2]!, 'base64url').toString()) as { secret: string }
    ).secret
    const verifier = newVerifier()
    org.noteInvite(secret, challengeOf(verifier))
    const inviteId = org.admitGoogle(entry.userId, 'ada@example.com', challengeOf(verifier))
    const fresh = startSignIn(db, {
      userId: entry.userId,
      redirectUri: callback,
      codeChallenge: challengeOf(verifier),
      inviteId
    })
    exchangeCode(
      { db, isAdmitted: org.active, org },
      { code: fresh, redirectUri: callback, codeVerifier: verifier }
    )
    expect(() => refreshTokens({ db, isAdmitted: org.active }, first.refreshToken)).toThrow(/valid/)
    expect(whoHolds({ db, isAdmitted: org.active }, first.accessToken)).toBeNull()
  })
})
