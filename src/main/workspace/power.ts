import type Database from 'better-sqlite3'
import type { WorkspacePower, WorkspacePowerPush } from '../../shared/ipc-contract'
import { getWorkspaceOrThrow } from '../db/repos/workspaces'

interface PowerOptions {
  db: Database.Database
  start(workspaceId: string): Promise<void>
  inspect?(workspaceId: string): Promise<boolean>
  stop(workspaceId: string): Promise<void>
  suspend(workspaceId: string): void
  changed(push: WorkspacePowerPush): void
  connectedUsers(): string[]
  busyWorkspaces(): string[]
  idleMs: number
  now?: () => number
}

/** One owner of container transitions. Nothing in this service sends a prompt or runs setup. */
export function createWorkspacePower(options: PowerOptions) {
  const { db } = options
  const now = options.now ?? Date.now
  const transitions = new Map<string, Promise<unknown>>()
  const idleSince = new Map<string, number>()
  const removing = new Set<string>()
  let closed = false

  function status(workspaceId: string): WorkspacePower {
    const workspace = getWorkspaceOrThrow(db, workspaceId)
    if (workspace.runtime !== 'container') throw new Error('Only cloud containers can be stopped or started')
    const row = db
      .prepare('SELECT power_state AS state, power_error AS error FROM workspaces WHERE id = ?')
      .get(workspaceId) as WorkspacePower
    return row
  }

  function update(workspaceId: string, state: WorkspacePower['state'], error: string | null = null): void {
    db.prepare('UPDATE workspaces SET power_state = ?, power_error = ? WHERE id = ?').run(
      state,
      error,
      workspaceId
    )
    options.changed({ workspaceId, state, error })
  }

  function serialize<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error('The cloud runner is shutting down'))
    const previous = transitions.get(workspaceId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => {
        if (closed) throw new Error('The cloud runner is shutting down')
        return action()
      })
    transitions.set(workspaceId, next)
    void next
      .finally(() => {
        if (transitions.get(workspaceId) === next) transitions.delete(workspaceId)
      })
      .catch(() => {})
    return next
  }

  async function stopInside(workspaceId: string): Promise<WorkspacePower> {
    if (status(workspaceId).state === 'stopped') return status(workspaceId)
    update(workspaceId, 'stopping')
    try {
      options.suspend(workspaceId)
      await options.stop(workspaceId)
      update(workspaceId, 'stopped')
      idleSince.delete(workspaceId)
      return status(workspaceId)
    } catch (error) {
      update(workspaceId, 'error', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  async function refreshInside(workspaceId: string): Promise<WorkspacePower> {
    if (
      status(workspaceId).state === 'running' &&
      options.inspect !== undefined &&
      !(await options.inspect(workspaceId))
    )
      return stopInside(workspaceId)
    return status(workspaceId)
  }

  const service = {
    status,
    refresh: (workspaceId: string) => serialize(workspaceId, () => refreshInside(workspaceId)),
    /** Used at every launcher, including delayed title and terminal calls. */
    assertRunning(workspaceId: string): void {
      if (closed) throw new Error('The cloud runner is shutting down')
      if (removing.has(workspaceId)) throw new Error('This workspace is being removed')
      const state = status(workspaceId).state
      if (state !== 'running' && state !== 'starting') {
        throw new Error(`Workspace is ${state}. Open or start it before running commands.`)
      }
    },
    /** Setup is the only caller allowed to start a brand-new container implicitly. */
    beforeStart(workspaceId: string): void {
      if (closed) throw new Error('The cloud runner is shutting down')
      if (
        getWorkspaceOrThrow(db, workspaceId).state === 'setting_up' &&
        status(workspaceId).state === 'stopped'
      ) {
        update(workspaceId, 'starting')
      } else service.assertRunning(workspaceId)
    },
    afterStart(workspaceId: string): void {
      service.assertRunning(workspaceId)
      if (status(workspaceId).state === 'starting') {
        update(workspaceId, 'running')
        idleSince.set(workspaceId, now())
      }
    },
    failed(workspaceId: string, error: unknown): void {
      if (closed || !db.open) return
      if (status(workspaceId).state === 'starting')
        update(workspaceId, 'error', error instanceof Error ? error.message : String(error))
    },
    start(workspaceId: string): Promise<WorkspacePower> {
      if (removing.has(workspaceId)) return Promise.reject(new Error('This workspace is being removed'))
      return serialize(workspaceId, async () => {
        if (removing.has(workspaceId)) throw new Error('This workspace is being removed')
        const workspace = getWorkspaceOrThrow(db, workspaceId)
        if (workspace.state !== 'ready')
          throw new Error('Workspace setup must finish successfully before starting')
        const current = await refreshInside(workspaceId)
        if (current.state === 'running') return current
        // A failed removal may have left processes alive: never declare a new container
        // running until removal of that old one has actually succeeded.
        if (current.state === 'error') await stopInside(workspaceId)
        update(workspaceId, 'starting')
        try {
          await options.start(workspaceId)
          service.afterStart(workspaceId)
          return status(workspaceId)
        } catch (error) {
          update(workspaceId, 'error', error instanceof Error ? error.message : String(error))
          throw error
        }
      })
    },
    stop(workspaceId: string): Promise<WorkspacePower> {
      return serialize(workspaceId, () => {
        const workspace = getWorkspaceOrThrow(db, workspaceId)
        if (workspace.state === 'initializing' || workspace.state === 'setting_up')
          throw new Error('Wait for workspace setup to finish before stopping it')
        return stopInside(workspaceId)
      })
    },
    remove(workspaceId: string, removeFiles: () => Promise<void>): Promise<void> {
      if (removing.has(workspaceId))
        return Promise.reject(new Error('This workspace is already being removed'))
      removing.add(workspaceId)
      return serialize(workspaceId, async () => {
        const workspace = getWorkspaceOrThrow(db, workspaceId)
        if (workspace.state === 'initializing' || workspace.state === 'setting_up')
          throw new Error('Wait for workspace setup to finish before removing it')
        await stopInside(workspaceId)
        await removeFiles()
      }).catch((error: unknown) => {
        removing.delete(workspaceId)
        throw error
      })
    },
    async sweep(): Promise<void> {
      if (closed) return
      const running = db
        .prepare(
          "SELECT id, owner_id FROM workspaces WHERE runtime = 'container' AND power_state = 'running' AND state = 'ready'"
        )
        .all() as Array<{ id: string; owner_id: string | null }>
      for (const workspace of running) {
        try {
          const actual = await service.refresh(workspace.id)
          if (actual.state !== 'running' || options.idleMs === 0) continue
        } catch (error) {
          console.warn('[loom-runner] could not inspect workspace power:', error)
          continue
        }
        const protectedNow = () =>
          options.connectedUsers().includes(workspace.owner_id ?? '') ||
          options.busyWorkspaces().includes(workspace.id)
        if (protectedNow()) {
          idleSince.delete(workspace.id)
          continue
        }
        const since = idleSince.get(workspace.id)
        if (since === undefined) {
          idleSince.set(workspace.id, now())
          continue
        }
        if (now() - since < options.idleMs) continue
        await serialize(workspace.id, async () => {
          if (protectedNow()) {
            idleSince.delete(workspace.id)
            return
          }
          await stopInside(workspace.id)
        }).catch((error: unknown) => console.warn('[loom-runner] idle stop failed:', error))
      }
    },
    async close(): Promise<void> {
      closed = true
      await Promise.allSettled([...transitions.values()])
    }
  }
  return service
}

export type WorkspacePowerService = ReturnType<typeof createWorkspacePower>
