import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { CloudSignInMode } from '../../shared/managed-cloud'
import type {
  Organization,
  OrgAdminEvent,
  OrgInvite,
  OrgMember,
  OrgOverview,
  OrgRole
} from '../../shared/org'

const MEMBER = `m.user_id AS userId, u.email, m.role, m.kind, m.state,
  m.joined_at AS joinedAt, m.removed_at AS removedAt, m.removed_by AS removedBy,
  m.purge_started_at AS purgeStartedAt, m.purged_at AS purgedAt`
const INVITE = `id, email, created_by AS createdBy, created_at AS createdAt,
  expires_at AS expiresAt, revoked_at AS revokedAt, used_at AS usedAt, used_by AS usedBy`
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000
const ATTEMPT_TTL = 10 * 60 * 1000
const hash = (secret: string): string => createHash('sha256').update(secret).digest('hex')

export class OrgError extends Error {}

export type OrgService = ReturnType<typeof createOrgService>

/** Authorization and its audit record share each SQLite transaction. */
export function createOrgService(
  db: Database.Database,
  config: { ownerEmail: string; publicUrl: string; mode?: CloudSignInMode }
) {
  function organization(): Organization | null {
    return (
      (db.prepare('SELECT name, created_by AS createdBy, created_at AS createdAt FROM organization').get() as
        Organization | undefined) ?? null
    )
  }
  function member(userId: string): OrgMember | null {
    return (
      (db
        .prepare(`SELECT ${MEMBER} FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.user_id = ?`)
        .get(userId) as OrgMember | undefined) ?? null
    )
  }
  function active(userId: string): boolean {
    return member(userId)?.state === 'active'
  }
  function owner(userId: string): boolean {
    const row = member(userId)
    return row?.state === 'active' && row.kind === 'human' && row.role === 'owner'
  }
  function requireOwner(actorId: string): void {
    if (!owner(actorId)) throw new OrgError('Only an organization owner can do this')
  }
  function audit(
    actorId: string,
    action: string,
    subject: string | null,
    detail: string | null = null,
    now = Date.now()
  ): void {
    db.prepare(
      'INSERT INTO org_admin_log (actor_id, action, subject, at, detail) VALUES (?, ?, ?, ?, ?)'
    ).run(actorId, action, subject, now, detail)
  }
  function protectLastOwner(userId: string): void {
    if (
      owner(userId) &&
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM org_members WHERE state = 'active' AND kind = 'human' AND role = 'owner'"
          )
          .get() as { n: number }
      ).n <= 1
    ) {
      throw new OrgError('The last active owner cannot be removed or demoted')
    }
  }
  function liveInvite(id: string, email: string, now = Date.now()): OrgInvite {
    const row = db
      .prepare(
        `SELECT ${INVITE} FROM org_invites WHERE id = ? AND email = ? AND revoked_at IS NULL AND used_at IS NULL AND expires_at > ?`
      )
      .get(id, email, now) as OrgInvite | undefined
    if (row === undefined)
      throw new OrgError('The invite is expired, revoked, already used, or for another email')
    return row
  }

  return {
    active,
    owner,
    member,
    organization,
    requireOwner,
    current(userId: string): OrgOverview | null {
      const org = organization()
      const row = member(userId)
      return org === null || row?.state !== 'active'
        ? null
        : { organization: org, role: row.role, kind: row.kind }
    },
    members(actorId: string): OrgMember[] {
      requireOwner(actorId)
      return db
        .prepare(
          `SELECT ${MEMBER} FROM org_members m JOIN users u ON u.id = m.user_id ORDER BY m.joined_at, m.user_id`
        )
        .all() as OrgMember[]
    },
    rename(actorId: string, name: string): void {
      const value = name.trim()
      if (value === '' || value.length > 100)
        throw new OrgError('Enter an organization name of 1 to 100 characters')
      db.transaction(() => {
        requireOwner(actorId)
        db.prepare('UPDATE organization SET name = ? WHERE singleton = 1').run(value)
        audit(actorId, 'org.rename', null, value)
      })()
    },
    setRole(actorId: string, userId: string, role: OrgRole): void {
      db.transaction(() => {
        requireOwner(actorId)
        if (role !== 'owner' && role !== 'member') throw new OrgError('Unknown organization role')
        if (!active(userId)) throw new OrgError('This person is not an active member')
        if (role === 'owner' && member(userId)?.kind === 'bot')
          throw new OrgError('Bot members cannot become organization owners')
        if (role === 'member') protectLastOwner(userId)
        db.prepare('UPDATE org_members SET role = ? WHERE user_id = ?').run(role, userId)
        audit(actorId, 'member.role', userId, role)
      })()
    },
    remove(actorId: string, userId: string): string[] {
      return db.transaction(() => {
        requireOwner(actorId)
        if (!active(userId)) throw new OrgError('This person is not an active member')
        protectLastOwner(userId)
        const now = Date.now()
        const ids = db
          .prepare('SELECT id FROM sign_ins WHERE user_id = ? AND revoked_at IS NULL')
          .all(userId) as Array<{ id: string }>
        db.prepare(
          "UPDATE org_members SET state = 'removed', removed_at = ?, removed_by = ?, purge_started_at = NULL, purged_at = NULL WHERE user_id = ?"
        ).run(now, actorId, userId)
        db.prepare('UPDATE sign_ins SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
          now,
          userId
        )
        db.prepare(
          'UPDATE org_invites SET revoked_at = ? WHERE email = (SELECT email FROM users WHERE id = ?) AND used_at IS NULL AND revoked_at IS NULL'
        ).run(now, userId)
        audit(actorId, 'member.remove', userId, null, now)
        db.prepare('DELETE FROM bot_grants WHERE user_id = ? OR bot_id = ?').run(userId, userId)
        db.prepare('DELETE FROM bot_subscription_grants WHERE bot_id = ?').run(userId)
        return ids.map((row) => row.id)
      })()
    },
    requestPurge(actorId: string, userId: string): OrgMember {
      return db.transaction(() => {
        requireOwner(actorId)
        const row = member(userId)
        if (row?.state !== 'removed') throw new OrgError('Only removed members can be purged')
        if (row.purgedAt !== null) throw new OrgError('This member’s files have already been deleted')
        if (row.purgeStartedAt === null) {
          db.prepare('UPDATE org_members SET purge_started_at = ? WHERE user_id = ?').run(Date.now(), userId)
          audit(actorId, 'member.purge.request', userId)
        }
        return member(userId)!
      })()
    },
    invites(actorId: string): OrgInvite[] {
      requireOwner(actorId)
      return db.prepare(`SELECT ${INVITE} FROM org_invites ORDER BY created_at DESC`).all() as OrgInvite[]
    },
    createInvite(actorId: string, email: string): { invite: OrgInvite; code: string } {
      return db.transaction(() => {
        requireOwner(actorId)
        const address = email.trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || address.length > 254)
          throw new OrgError('Enter a work email address')
        if (
          db
            .prepare(
              `SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id
          WHERE u.email = ? COLLATE NOCASE AND m.state = 'active'`
            )
            .get(address) !== undefined
        ) {
          throw new OrgError('This person is already an active member')
        }
        const now = Date.now()
        const id = randomUUID()
        const secret = randomBytes(32).toString('base64url')
        db.prepare(
          'INSERT INTO org_invites (id, secret_hash, email, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, hash(secret), address, actorId, now, now + INVITE_TTL)
        audit(actorId, 'invite.create', id, address, now)
        const invite = db.prepare(`SELECT ${INVITE} FROM org_invites WHERE id = ?`).get(id) as OrgInvite
        const host = new URL(config.publicUrl).origin
        return {
          invite,
          code: `loom-invite.v1.${Buffer.from(JSON.stringify({ host, secret, ...(config.mode === 'managed' ? { mode: config.mode } : {}) })).toString('base64url')}`
        }
      })()
    },
    revokeInvite(actorId: string, id: string): void {
      db.transaction(() => {
        requireOwner(actorId)
        const result = db
          .prepare(
            'UPDATE org_invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL'
          )
          .run(Date.now(), id)
        if (result.changes === 0) throw new OrgError('This invite is not pending')
        audit(actorId, 'invite.revoke', id)
      })()
    },
    noteInvite(secret: string, codeChallenge: string): void {
      if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) || !/^[A-Za-z0-9_-]{43}$/.test(secret))
        throw new OrgError('Invalid invite request')
      db.transaction(() => {
        const now = Date.now()
        const invite = db
          .prepare(
            'SELECT id FROM org_invites WHERE secret_hash = ? AND expires_at > ? AND revoked_at IS NULL AND used_at IS NULL'
          )
          .get(hash(secret), now) as { id: string } | undefined
        if (invite === undefined) throw new OrgError('This invite is expired, revoked, or already used')
        db.prepare('DELETE FROM org_invite_attempts WHERE expires_at <= ?').run(now)
        const known = db
          .prepare('SELECT invite_id FROM org_invite_attempts WHERE code_challenge = ?')
          .get(codeChallenge) as { invite_id: string } | undefined
        if (known !== undefined && known.invite_id !== invite.id)
          throw new OrgError('Start joining again from Loom')
        db.prepare(
          'INSERT OR IGNORE INTO org_invite_attempts (code_challenge, invite_id, expires_at) VALUES (?, ?, ?)'
        ).run(codeChallenge, invite.id, now + ATTEMPT_TTL)
      })()
    },
    /** Called only after Google has verified the account and allowed Workspace domain. */
    admitGoogle(userId: string, email: string, codeChallenge: string): string | null {
      if (member(userId)?.kind === 'bot') throw new OrgError('Bot members cannot sign in as humans')
      return db.transaction(() => {
        if (organization() === null && email === config.ownerEmail.trim().toLowerCase()) {
          const now = Date.now()
          db.prepare(
            "INSERT INTO organization (singleton, name, created_by, created_at) VALUES (1, '', ?, ?)"
          ).run(userId, now)
          db.prepare(
            "INSERT INTO org_members (user_id, role, kind, state, joined_at) VALUES (?, 'owner', 'human', 'active', ?)"
          ).run(userId, now)
          audit(userId, 'org.create', userId, null, now)
        }
        const noted = db
          .prepare('SELECT invite_id FROM org_invite_attempts WHERE code_challenge = ? AND expires_at > ?')
          .get(codeChallenge, Date.now()) as { invite_id: string } | undefined
        if (noted === undefined) {
          if (active(userId)) return null
          throw new OrgError('This account has not been invited to the organization')
        }
        liveInvite(noted.invite_id, email)
        return noted.invite_id
      })()
    },
    /** Runs inside token exchange's transaction; failure spends neither code nor invite. */
    redeemInvite(id: string, userId: string, email: string, codeChallenge: string, now: number): void {
      const noted = db
        .prepare('SELECT invite_id FROM org_invite_attempts WHERE code_challenge = ? AND expires_at > ?')
        .get(codeChallenge, now) as { invite_id: string } | undefined
      if (noted?.invite_id !== id) throw new OrgError('The invite sign-in has expired; start joining again')
      liveInvite(id, email, now)
      const previous = member(userId)
      if (
        previous?.state === 'removed' &&
        (previous.purgeStartedAt !== null ||
          (previous.removedAt !== null && previous.removedAt <= now - 30 * 24 * 60 * 60 * 1000)) &&
        previous.purgedAt === null
      ) {
        throw new OrgError('Retained data cleanup pending; retry after owner cleanup')
      }
      db.prepare('UPDATE org_invites SET used_at = ?, used_by = ? WHERE id = ?').run(now, userId, id)
      db.prepare(
        `INSERT INTO org_members (user_id, role, kind, state, joined_at) VALUES (?, 'member', 'human', 'active', ?)
        ON CONFLICT(user_id) DO UPDATE SET state = 'active',
          role = CASE WHEN org_members.state = 'active' THEN org_members.role ELSE 'member' END,
          removed_at = NULL, removed_by = NULL, purge_started_at = NULL, purged_at = NULL`
      ).run(userId, now)
      db.prepare('DELETE FROM org_invite_attempts WHERE invite_id = ?').run(id)
      audit(userId, 'member.join', userId, null, now)
    },
    adminLog(actorId: string, before = Number.MAX_SAFE_INTEGER): OrgAdminEvent[] {
      requireOwner(actorId)
      return db
        .prepare(
          'SELECT id, actor_id AS actorId, action, subject, at, detail FROM org_admin_log WHERE id < ? ORDER BY id DESC LIMIT 100'
        )
        .all(before) as OrgAdminEvent[]
    },
    dueRemoved(now = Date.now()): OrgMember[] {
      return db
        .prepare(
          `SELECT ${MEMBER} FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.state = 'removed' AND m.purged_at IS NULL AND (m.purge_started_at IS NOT NULL OR m.removed_at <= ?)`
        )
        .all(now - 30 * 24 * 60 * 60 * 1000) as OrgMember[]
    },
    markPurged(userId: string, now = Date.now()): void {
      db.transaction(() => {
        const row = member(userId)
        if (row?.state !== 'removed' || row.removedBy === null)
          throw new OrgError('Only removed members can be purged')
        db.prepare('UPDATE org_members SET purged_at = ? WHERE user_id = ?').run(now, userId)
        audit(row.removedBy, 'member.purge', userId, null, now)
      })()
    }
  }
}
