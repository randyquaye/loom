import type Database from 'better-sqlite3'
import { CALL_SUBJECTS, type SubjectKind } from '../../shared/call-subjects'
import type { SessionActivity } from '../../shared/ipc-contract'
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
  'org:log'
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
  /** A terminal is a process, not a row: its owner is whoever's call started it. */
  const terminalOwners = new Map<string, string>()

  function ownerOf(kind: SubjectKind, id: string): string | null {
    if (kind === 'terminal') return terminalOwners.get(id) ?? null
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

    /** Throws unless `caller` may make this call with this (already validated) input. */
    assertMayCall(caller: Caller, channel: string, parsed: unknown): void {
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
        if (typeof id !== 'string' || ownerOf(kind, id) !== caller.userId)
          throw new NotFoundError(kind, String(id))
      }
    },

    /** Two calls start terminals and answer with the new terminal's id. */
    noteResult(caller: Caller, channel: string, result: unknown): void {
      if (
        (channel === 'terminal:create' || channel === 'workspaces:runAction') &&
        typeof result === 'string'
      ) {
        terminalOwners.set(result, caller.userId)
      }
    },

    forgetTerminal(id: string): void {
      terminalOwners.delete(id)
    },

    /** Which tabs are busy, cut down to the tabs of one user's workspaces. */
    activityFor(userId: string, activity: SessionActivity): SessionActivity {
      const bySession = Object.fromEntries(
        Object.entries(activity.bySession).filter(
          ([, workspaceId]) => ownerOfWorkspace.get(workspaceId)?.owner_id === userId
        )
      )
      return { revision: activity.revision, bySession }
    }
  }
}

export type AccessRules = ReturnType<typeof createAccess>
