import type Database from 'better-sqlite3'
import { MOBILE_CAPABILITY } from '../../shared/runner-capabilities'
import { listProjects } from '../db/repos/projects'
import { handle, type Caller } from '../ipc/registry'
import type { AccessRules } from './access'

/** A leaked phone token cannot exercise desktop-only execution or administration. */
const MOBILE_CALLS: ReadonlySet<string> = new Set([
  'app:ping',
  'projects:list',
  'workspaces:list',
  'workspaces:power',
  'workspaces:start',
  'workspaces:stop',
  'sessions:list',
  'sessions:activity',
  'sessions:unread',
  'sessions:markRead',
  'sessions:eventsAfter',
  'sessions:send',
  'sessions:cancel',
  'sessions:answerQuestion',
  'sessions:queue',
  'files:listDir',
  'files:read',
  'git:status',
  'git:diff'
])

const MOBILE_PUSHES: ReadonlySet<string> = new Set([
  'session:event',
  'session:activity',
  'session:queue',
  'session:title',
  'workspace:state',
  'workspaces:powerChanged',
  'bots:changed'
])

export function createMobileAccess(db: Database.Database) {
  // Issued by authentication and retained across rotation. Client headers cannot grant
  // desktop authority, and authorization-code cleanup cannot change a token's scope.
  const signIn = db.prepare<[string, string], { client_kind: 'desktop' | 'mobile' }>(
    'SELECT client_kind FROM sign_ins WHERE id=? AND user_id=? AND revoked_at IS NULL'
  )

  function client(caller: Caller): 'desktop' | 'mobile' | 'invalid' {
    if (caller.signInId === undefined) return 'desktop'
    return signIn.get(caller.signInId, caller.userId)?.client_kind ?? 'invalid'
  }

  return {
    assertMayCall(caller: Caller, channel: string): void {
      const kind = client(caller)
      if (kind === 'invalid') throw new Error('This sign-in is no longer valid')
      if (kind === 'mobile' && !MOBILE_CALLS.has(channel))
        throw new Error('This action is not available to mobile sign-ins')
    },
    isDesktop: (caller: Caller): boolean => client(caller) === 'desktop',
    mayReceive(caller: Caller, channel: string): boolean {
      const kind = client(caller)
      return kind === 'desktop' || (kind === 'mobile' && MOBILE_PUSHES.has(channel))
    }
  }
}

/** A phone has no local repository inventory; reveal only projects it can currently view. */
export function registerMobileDiscovery(db: Database.Database, access: AccessRules): void {
  const workspaces = db.prepare<[], { id: string; project_id: string }>(
    'SELECT id,project_id FROM workspaces'
  )
  handle('projects:list', (_input, caller) => {
    if (caller === undefined) throw new Error('This call needs a signed-in user')
    if (!caller.capabilities?.includes(MOBILE_CAPABILITY))
      throw new Error('Update the app to enable mobile workspace discovery')
    const visible = new Set(
      workspaces
        .all()
        .filter((row) => access.mayViewWorkspace(caller.userId, row.id, caller.capabilities))
        .map((row) => row.project_id)
    )
    return listProjects(db).filter((project) => visible.has(project.id))
  })
}
