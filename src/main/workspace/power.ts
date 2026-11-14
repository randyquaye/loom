import type Database from 'better-sqlite3'
import type { WorkspacePower, WorkspacePowerPush } from '../../shared/ipc-contract'
import { getWorkspaceOrThrow } from '../db/repos/workspaces'

/** Which weak signals were holding a workspace up when its owner was asked about it. */
export type IdleReason = 'forward' | 'command' | 'both'

/**
 * What the idle rule watches. A running turn and terminal I/O are strong signals: someone is
 * working. A live forward and a running command are weak: they hold a workspace up, but
 * after long enough its owner is asked. A signed-in desktop is no signal at all.
 */
export interface IdleSignals {
  /** The workspaces with a turn running. */
  busyWorkspaces(): string[]
  /** When a byte was last typed into, or printed by, one of the workspace's terminals. */
  terminalIoAt(workspaceId: string): number | undefined
  /** The workspaces with a connection live through a port forward. */
  forwardedWorkspaces(): string[]
  /** Whether the shell of one of the workspace's terminals has a child process. */
  runningCommand(workspaceId: string): Promise<boolean>
}

/** The question "are you still using this?", as the idle rule needs it. */
export interface IdlePrompts {
  /** The question open about a workspace: when it was asked, and when silence stops the workspace. */
  open(workspaceId: string): { raisedAt: number; stopAt: number } | null
  raise(workspaceId: string, reason: IdleReason, stopAt: number): void
  /** A strong signal arrived while the question was open, which answers it. */
  kept(workspaceId: string): void
}

interface PowerOptions {
  db: Database.Database
  start(workspaceId: string): Promise<void>
  admitStart?(workspaceId: string, reserve: () => void): Promise<void>
  inspect?(workspaceId: string): Promise<boolean>
  stop(workspaceId: string): Promise<void>
  suspend(workspaceId: string): void
  changed(push: WorkspacePowerPush): void
  signals: IdleSignals
  prompts?: IdlePrompts
  /** X: a workspace stops after this long with no signal at all. Zero turns the rule off. */
  idleMs: number
  now?: () => number
}

/** The owner is asked once only weak signals have held a workspace for this many X. Not a setting. */
const ASK_AFTER = 3
/** Looking for a running command costs a process in the container, so it is rationed. */
const COMMAND_CHECK_MS = 60_000

interface Clocks {
  /** The last moment any signal was seen. */
  lastAny: number
  /** The last moment a turn was running or terminal I/O happened. */
  lastStrong: number
  commandCheckedAt: number
  /** What the last look for a running command found. */
  command: boolean
  /** The weak signals seen most recently. */
  held: IdleReason
}

/** One owner of container transitions. Nothing in this service sends a prompt or runs setup. */
export function createWorkspacePower(options: PowerOptions) {
  const { db, signals, prompts } = options
  const now = options.now ?? Date.now
  const transitions = new Map<string, Promise<unknown>>()
  const removing = new Set<string>()
  let closed = false
  /** One entry per running workspace. A runner restart starts them afresh. */
  const clocks = new Map<string, Clocks>()

  function startClocks(workspaceId: string): Clocks {
    const at = now()
    const fresh: Clocks = {
      lastAny: at,
      lastStrong: at,
      commandCheckedAt: at,
      command: false,
      held: 'command'
    }
    clocks.set(workspaceId, fresh)
    return fresh
  }

  const clocksOf = (workspaceId: string): Clocks => clocks.get(workspaceId) ?? startClocks(workspaceId)

  /** Not while someone is working there, and at most once a minute. */
  async function lookForCommand(workspaceId: string): Promise<void> {
    const clock = clocksOf(workspaceId)
    const at = now()
    if (at - clock.commandCheckedAt < COMMAND_CHECK_MS || at - clock.lastStrong < COMMAND_CHECK_MS) return
    clock.commandCheckedAt = at
    clock.command = await signals.runningCommand(workspaceId).catch(() => false)
    if (clock.command) clock.lastAny = Math.max(clock.lastAny, at)
  }

  /**
   * Reads the signals of this moment into the workspace's clocks, settles or raises the
   * question, and says whether the workspace is to stop now.
   */
  function idleOut(workspaceId: string): boolean {
    const clock = clocksOf(workspaceId)
    const at = now()
    const turn = signals.busyWorkspaces().includes(workspaceId)
    clock.lastStrong = Math.max(clock.lastStrong, turn ? at : 0, signals.terminalIoAt(workspaceId) ?? 0)
    const forward = signals.forwardedWorkspaces().includes(workspaceId)
    if (forward || clock.command) clock.held = !forward ? 'command' : clock.command ? 'both' : 'forward'
    clock.lastAny = Math.max(clock.lastAny, clock.lastStrong, forward ? at : 0)

    let asked = prompts?.open(workspaceId) ?? null
    if (asked !== null && clock.lastStrong > asked.raisedAt) {
      prompts?.kept(workspaceId)
      asked = null
    }
    if (at - clock.lastAny >= options.idleMs || (asked !== null && at >= asked.stopAt)) return true
    if (asked === null && at - clock.lastStrong >= ASK_AFTER * options.idleMs) {
      prompts?.raise(workspaceId, clock.held, at + options.idleMs)
    }
    return false
  }

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
    clocks.delete(workspaceId)
    try {
      options.suspend(workspaceId)
      await options.stop(workspaceId)
      update(workspaceId, 'stopped')
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
        startClocks(workspaceId)
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
        const reserve = () => update(workspaceId, 'starting')
        if (options.admitStart === undefined) reserve()
        else await options.admitStart(workspaceId, reserve)
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
    /** Offboarding must also stop a workspace whose setup is still in progress. */
    stopForRemoval: (workspaceId: string) => serialize(workspaceId, () => stopInside(workspaceId)),
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
    /** The owner said they are still using it, which counts as a strong signal now. */
    keep(workspaceId: string): void {
      const clock = clocks.get(workspaceId)
      if (clock !== undefined) clock.lastStrong = clock.lastAny = now()
    },
    async sweep(): Promise<void> {
      if (closed) return
      const running = db
        .prepare("SELECT id, state FROM workspaces WHERE runtime = 'container' AND power_state = 'running'")
        .all() as Array<{ id: string; state: string }>
      for (const workspace of running) {
        // Setup is work under way, and a failed one is left for its owner to look at.
        if (workspace.state !== 'ready') {
          startClocks(workspace.id)
          continue
        }
        try {
          const actual = await service.refresh(workspace.id)
          if (actual.state !== 'running' || options.idleMs === 0) continue
        } catch (error) {
          console.warn('[loom-runner] could not inspect workspace power:', error)
          continue
        }
        await lookForCommand(workspace.id)
        if (!idleOut(workspace.id)) continue
        // A signal may arrive while the stop waits its turn; it is asked again once inside.
        await serialize(workspace.id, async () => {
          if (status(workspace.id).state === 'running' && idleOut(workspace.id))
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
