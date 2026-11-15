import type Database from 'better-sqlite3'
import { CALL_SUBJECTS, type SubjectKind } from '../../shared/call-subjects'
import type { SessionActivity } from '../../shared/ipc-contract'
import { RUNNER_CAPABILITIES, supportsBots, supportsSubscriptions } from '../../shared/runner-capabilities'
import type { Caller } from '../ipc/registry'

export type Access = 'owner' | 'orgOwner' | 'open'

const ORG_OWNER_CALLS: ReadonlySet<string> = new Set([
  'org:update',
  'org:members',
  'org:invite',
  'org:invites',
  'org:revokeInvite',
  'org:setRole',
  'org:removeMember',
  'org:purgeMember',
  'org:log',
  'bots:create',
  'bots:update',
  'bots:grants',
  'bots:setGrant',
  'bots:logins',
  'bots:connectClaude',
  'bots:connectCodex',
  'bots:setGithub',
  'bots:disconnect',
  'subscriptions:list',
  'subscriptions:create',
  'subscriptions:update',
  'subscriptions:connectClaude',
  'subscriptions:connectCodex',
  'subscriptions:status',
  'subscriptions:disconnect',
  'subscriptions:grants',
  'subscriptions:setGrant'
])

/** What the runner serves beyond the window's calls, placed the same way. */
const RUNNER_SUBJECTS: Record<string, readonly [SubjectKind, string]> = {
  ...CALL_SUBJECTS,
  'files:upload': ['session', 'sessionId']
}

/**
 * Calls any user may make. They are about no one workspace: each either names a project,
 * which on a runner is only a repository's address, or answers with the caller's own things.
 */
const OPEN_CALLS: ReadonlySet<string> = new Set([
  'app:ping',
  'bots:list',
  'bots:invoke',
  'bots:invocations',
  'bots:open',
  'org:get',
  'cloud:health',
  'projects:ensure',
  'git:branches',
  'workspaces:list',
  'workspaces:add',
  'sessions:activity',
  'sessions:unread',
  'history:search',
  'notifications:list',
  'notifications:read',
  'env:list',
  'env:set',
  'env:delete',
  'logins:status',
  'logins:connectClaude',
  'logins:connectCodex',
  'logins:connectGithub',
  'logins:finishGithub',
  'logins:checkGithub',
  'github:prs',
  'github:branchPrs',
  'logins:disconnect'
])

/** Read access is explicit: a new workspace call defaults to requiring control. */
const VIEW_CALLS: ReadonlySet<string> = new Set([
  'workspaces:power',
  'workspaces:scripts',
  'ports:list',
  'git:status',
  'git:diff',
  'git:checkpoints',
  'git:diffCheckpoint',
  'github:workspacePr',
  'sessions:list',
  'sessions:closed',
  'sessions:markRead',
  'sessions:events',
  'sessions:eventsAfter',
  'sessions:instructions',
  'sessions:exportMarkdown',
  'sessions:queue',
  'comments:list',
  'files:tree',
  'files:listDir',
  'files:read',
  'files:preview',
  'files:reveal',
  'terminal:list'
])

/**
 * How a call is guarded. Undefined means nobody has decided, and such a call is refused:
 * a call added to the runner is closed to everyone until it is placed here.
 */
export function accessOf(channel: string): Access | undefined {
  if (ORG_OWNER_CALLS.has(channel)) return 'orgOwner'
  if (channel in RUNNER_SUBJECTS) return 'owner'
  return OPEN_CALLS.has(channel) ? 'open' : undefined
}

/**
 * Calls that name a second thing besides their subject. A fork is made in one workspace out
 * of a tab that may be in another: the tab's whole conversation is copied, so it must be the
 * caller's own just as the workspace must.
 */
const ALSO_NAMED: Partial<Record<string, ReadonlyArray<readonly [SubjectKind, string]>>> = {
  'sessions:fork': [['session', 'sourceSessionId']]
}

export class NotFoundError extends Error {
  constructor(kind: SubjectKind, id: string) {
    // Someone else's workspace and one that never existed read the same from outside.
    super(`${kind} ${id} was not found`)
    this.name = 'NotFoundError'
  }
}

/** Every workspace on a runner has one owner; this answers whose a thing is, and guards calls with it. */
export function createAccess(db: Database.Database, isOrgOwner: (userId: string) => boolean = () => false) {
  const ownerOfWorkspace = db.prepare<[string], { owner_id: string | null }>(
    'SELECT owner_id FROM workspaces WHERE id = ?'
  )
  const ownerOfSession = db.prepare<[string], { owner_id: string | null }>(
    'SELECT w.owner_id FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?'
  )
  const ownerOfComment = db.prepare<[string], { owner_id: string | null }>(
    'SELECT w.owner_id FROM diff_comments c JOIN workspaces w ON w.id = c.workspace_id WHERE c.id = ?'
  )
  const ownerOfNotification = db.prepare<[string], { owner_id: string | null }>(
    'SELECT owner_id FROM notifications WHERE id = ?'
  )
  /** Terminals retain their creator for audit and their workspace for current grants. */
  const terminalOwners = new Map<string, { userId: string; workspaceId?: string }>()
  const workspaceOfSession = db.prepare<[string], { workspace_id: string }>(
    'SELECT workspace_id FROM sessions WHERE id=?'
  )
  const workspaceOfComment = db.prepare<[string], { workspace_id: string }>(
    'SELECT workspace_id FROM diff_comments WHERE id=?'
  )
  const workspaceOfNotification = db.prepare<[string], { workspace_id: string | null }>(
    'SELECT workspace_id FROM notifications WHERE id=?'
  )
  const botMembership = db.prepare<[string], { kind: string; state: string; enabled: number | null }>(
    'SELECT m.kind,m.state,b.enabled FROM org_members m LEFT JOIN bots b ON b.user_id=m.user_id WHERE m.user_id=?'
  )
  const humanGrant = db.prepare<[string, string], { access: string }>(
    `SELECT g.access FROM bot_grants g JOIN org_members m ON m.user_id=g.user_id
     WHERE g.bot_id=? AND g.user_id=? AND m.kind='human' AND m.state='active'`
  )

  function workspaceOf(kind: SubjectKind, id: string): string | null {
    if (kind === 'workspace') return ownerOfWorkspace.get(id) === undefined ? null : id
    if (kind === 'terminal') return terminalOwners.get(id)?.workspaceId ?? null
    const queries = {
      session: workspaceOfSession,
      comment: workspaceOfComment,
      notification: workspaceOfNotification
    }
    return queries[kind].get(id)?.workspace_id ?? null
  }

  function isBotWorkspace(workspaceId: string): boolean {
    const owner = ownerOfWorkspace.get(workspaceId)?.owner_id
    return owner !== undefined && owner !== null && botMembership.get(owner)?.kind === 'bot'
  }

  function mayAccessWorkspace(
    userId: string,
    workspaceId: string,
    control: boolean,
    capabilities: readonly string[]
  ): boolean {
    const owner = ownerOfWorkspace.get(workspaceId)?.owner_id
    if (owner === undefined || owner === null) return false
    const member = botMembership.get(owner)
    if (member?.kind !== 'bot') return owner === userId
    if (!supportsBots(capabilities)) return false
    if (member.state !== 'active' || member.enabled === null || (control && member.enabled !== 1))
      return false
    const access = humanGrant.get(owner, userId)?.access
    return access === 'control' || (!control && access === 'view')
  }

  const mayViewWorkspace = (
    userId: string,
    workspaceId: string,
    capabilities: readonly string[] = RUNNER_CAPABILITIES
  ) => mayAccessWorkspace(userId, workspaceId, false, capabilities)
  const mayControlWorkspace = (
    userId: string,
    workspaceId: string,
    capabilities: readonly string[] = RUNNER_CAPABILITIES
  ) => mayAccessWorkspace(userId, workspaceId, true, capabilities)

  function ownerOf(kind: SubjectKind, id: string): string | null {
    if (kind === 'terminal') return terminalOwners.get(id)?.userId ?? null
    const lookups = {
      workspace: ownerOfWorkspace,
      session: ownerOfSession,
      comment: ownerOfComment,
      notification: ownerOfNotification
    }
    return lookups[kind].get(id)?.owner_id ?? null
  }

  return {
    ownerOf,
    workspaceOf,
    isBotWorkspace,
    mayViewWorkspace,
    mayControlWorkspace,
    viewers(workspaceId: string): string[] {
      const owner = ownerOfWorkspace.get(workspaceId)?.owner_id
      if (owner === undefined || owner === null) return []
      if (botMembership.get(owner)?.kind !== 'bot') return [owner]
      const candidates = db
        .prepare('SELECT user_id AS userId FROM bot_grants WHERE bot_id=?')
        .all(owner) as Array<{ userId: string }>
      return candidates
        .filter(({ userId }) => mayViewWorkspace(userId, workspaceId))
        .map(({ userId }) => userId)
    },

    /** Throws unless `caller` may make this call with this (already validated) input. */
    assertMayCall(caller: Caller, channel: string, parsed: unknown): void {
      const capabilities = caller.capabilities ?? RUNNER_CAPABILITIES
      if (channel.startsWith('bots:') && !supportsBots(capabilities))
        throw new Error('This desktop does not support bots; update Loom')
      if (channel.startsWith('subscriptions:') && !supportsSubscriptions(capabilities))
        throw new Error('This desktop does not support subscriptions; update Loom')
      const access = accessOf(channel)
      if (access === 'open') return
      if (access === 'orgOwner') {
        if (!isOrgOwner(caller.userId)) throw new Error('Only an organization owner can do this')
        return
      }
      const subject = RUNNER_SUBJECTS[channel]
      if (access === undefined || subject === undefined) {
        throw new Error(`${channel} is not available to users of this runner`)
      }
      // Everything of someone's that the call names must be the caller's, not only its subject.
      for (const [kind, field] of [subject, ...(ALSO_NAMED[channel] ?? [])]) {
        const id = (parsed as Record<string, unknown>)[field]
        if (typeof id !== 'string') throw new NotFoundError(kind, String(id))
        const workspaceId = workspaceOf(kind, id)
        if (!supportsBots(capabilities) && workspaceId !== null && isBotWorkspace(workspaceId))
          throw new NotFoundError(kind, id)
        const allowed =
          kind === 'notification' || workspaceId === null
            ? ownerOf(kind, id) === caller.userId
            : VIEW_CALLS.has(channel)
              ? mayViewWorkspace(caller.userId, workspaceId, capabilities)
              : mayControlWorkspace(caller.userId, workspaceId, capabilities)
        if (!allowed) throw new NotFoundError(kind, id)
      }
      if (channel === 'sessions:fork') {
        const input = parsed as { workspaceId: string; sourceSessionId: string }
        if (ownerOf('workspace', input.workspaceId) !== ownerOf('session', input.sourceSessionId)) {
          throw new NotFoundError('session', input.sourceSessionId)
        }
      }
    },

    /** Two calls start terminals and answer with the new terminal's id. */
    noteResult(caller: Caller, channel: string, result: unknown, parsed?: unknown): void {
      if (
        (channel === 'terminal:create' || channel === 'workspaces:runAction') &&
        typeof result === 'string'
      ) {
        const workspaceId = (parsed as { workspaceId?: unknown } | undefined)?.workspaceId
        terminalOwners.set(result, {
          userId: terminalOwners.get(result)?.userId ?? caller.userId,
          ...(typeof workspaceId === 'string' ? { workspaceId } : {})
        })
      }
    },

    forgetTerminal(id: string): void {
      terminalOwners.delete(id)
    },

    /** Which tabs are busy, cut down to the tabs of one user's workspaces. */
    activityFor(
      userId: string,
      activity: SessionActivity,
      capabilities: readonly string[] = RUNNER_CAPABILITIES
    ): SessionActivity {
      const bySession = Object.fromEntries(
        Object.entries(activity.bySession).filter(([, workspaceId]) =>
          mayViewWorkspace(userId, workspaceId, capabilities)
        )
      )
      return { revision: activity.revision, bySession }
    }
  }
}

export type AccessRules = ReturnType<typeof createAccess>
