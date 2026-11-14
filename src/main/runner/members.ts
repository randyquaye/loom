import { rm } from 'node:fs/promises'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { OrgMember } from '../../shared/org'
import { getProjectOrThrow } from '../db/repos/projects'
import { getWorkspaceOrThrow } from '../db/repos/workspaces'
import type { Logins } from '../logins/service'
import type { OrgService } from '../org/service'
import { destroyTerminalsForCwd } from '../pty'
import { homeFolder } from '../runtime'
import type { SecretStore } from '../secrets'
import { suspendWorkspaceSessions } from '../sessions/service'
import { removeWorkspace } from '../workspace/bootstrap'
import type { WorkspacePowerService } from '../workspace/power'

interface CleanupOptions {
  db: Database.Database
  org: OrgService | null
  dataDir: string
  secrets: SecretStore
  logins: Logins | null
  power: Pick<WorkspacePowerService, 'stopForRemoval'>
  closeConnections(userId: string): void
}

/** Authorization ends synchronously; stopping and eventual deletion follow that durable decision. */
export function createMemberCleanup(options: CleanupOptions) {
  const { db, org } = options
  const pending = new Set<Promise<unknown>>()
  const purges = new Map<string, Promise<void>>()
  let sweeping: Promise<void> | null = null
  let closed = false
  const owned = (userId: string) =>
    (db.prepare('SELECT id FROM workspaces WHERE owner_id = ?').all(userId) as Array<{ id: string }>).map(
      (row) => getWorkspaceOrThrow(db, row.id)
    )

  function track<T>(work: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error('The cloud runner is shutting down'))
    const task = work()
    pending.add(task)
    void task.finally(() => pending.delete(task)).catch(() => {})
    return task
  }

  async function stop(userId: string): Promise<void> {
    options.closeConnections(userId)
    options.logins?.revokeAccess(userId)
    const results = await Promise.allSettled(
      owned(userId).map(async (workspace) => {
        suspendWorkspaceSessions(db, workspace.id)
        destroyTerminalsForCwd(workspace.worktreePath)
        if (workspace.runtime === 'container') await options.power.stopForRemoval(workspace.id)
      })
    )
    for (const result of results)
      if (result.status === 'rejected')
        console.warn('[loom-runner] could not stop a removed member workspace:', result.reason)
    if (results.some((result) => result.status === 'rejected'))
      throw new Error(
        'Member removed and access revoked; some workspaces could not stop. Check runner logs before restarting.'
      )
  }

  function audit(member: OrgMember, action: string): void {
    db.prepare('INSERT INTO org_admin_log(actor_id,action,subject,at) VALUES (?,?,?,?)').run(
      member.removedBy,
      action,
      member.userId,
      Date.now()
    )
  }

  async function purge(member: OrgMember): Promise<void> {
    await stop(member.userId)
    if (
      owned(member.userId).some(
        (workspace) => workspace.state === 'initializing' || workspace.state === 'setting_up'
      )
    )
      throw new Error('Cleanup is waiting for workspace setup to settle; the daily sweep will retry')
    audit(member, 'member.purge.start')
    try {
      await options.logins?.forget(member.userId)
      for (const workspace of owned(member.userId)) {
        await rm(path.join(options.dataDir, 'logs', workspace.id), { recursive: true, force: true })
        await removeWorkspace({
          db,
          repoPath: getProjectOrThrow(db, workspace.projectId).repoPath,
          workspace,
          dataRoot: options.dataDir
        })
      }
      for (const prefix of [`user::${member.userId}::`, `login::${member.userId}::`])
        for (const key of await options.secrets.listRaw(prefix)) await options.secrets.deleteRaw(key)
      // login-files-view is a read-only view of login-files; deleting the source empties both.
      await rm(homeFolder(options.dataDir, member.userId), { recursive: true, force: true })
      await rm(path.join(options.dataDir, 'login-files', member.userId), { recursive: true, force: true })
      db.transaction(() => {
        db.prepare('DELETE FROM notifications WHERE owner_id = ?').run(member.userId)
        db.prepare('DELETE FROM sign_ins WHERE user_id = ?').run(member.userId)
        org!.markPurged(member.userId)
      })()
    } catch (error) {
      audit(member, 'member.purge.failed')
      throw error
    }
  }

  function purgeOnce(member: OrgMember): Promise<void> {
    const existing = purges.get(member.userId)
    if (existing !== undefined) return existing
    const task = purge(member).finally(() => purges.delete(member.userId))
    purges.set(member.userId, task)
    return task
  }

  return {
    remove(actorId: string, userId: string): Promise<void> {
      return track(async () => {
        if (org === null) throw new Error('This runner has no organization')
        org.remove(actorId, userId)
        await stop(userId)
      })
    },
    purgeMember(actorId: string, userId: string): Promise<void> {
      return track(async () => {
        if (org === null) throw new Error('This runner has no organization')
        const member = org.requestPurge(actorId, userId)
        await purgeOnce(member)
      })
    },
    sweep(): Promise<void> {
      if (closed || org === null) return Promise.resolve()
      if (sweeping !== null) return sweeping
      sweeping = track(async () => {
        for (const member of org.dueRemoved()) {
          try {
            await purgeOnce(member)
          } catch (error) {
            console.warn(`[loom-runner] cleanup failed for ${member.userId}:`, error)
          }
        }
      }).finally(() => {
        sweeping = null
      })
      return sweeping
    },
    async close(): Promise<void> {
      closed = true
      await Promise.allSettled([...pending])
    }
  }
}
