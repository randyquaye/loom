import type Database from 'better-sqlite3'

interface QuiescenceOptions {
  db: Database.Database
  blocked: Set<string>
  interrupt(botId: string): void
  revokeCredentials(botId: string): void
  closeForwards(workspaceId: string): void
  stopSession(sessionId: string): void
  stopTerminals(workspaceId: string): void
  stopWorkspace(workspaceId: string): Promise<unknown>
}

/** Admission stays closed until every resource from the old authority is gone. */
export function createBotQuiescence(options: QuiescenceOptions) {
  const { db, blocked } = options
  const pending = new Map<string, Promise<void>>()

  function stop(botId: string): Promise<void> {
    blocked.add(botId)
    const existing = pending.get(botId)
    if (existing !== undefined) return existing
    const task = Promise.resolve().then(async () => {
      const jobs: Promise<unknown>[] = []
      const attempt = (action: () => unknown) => {
        try {
          jobs.push(Promise.resolve(action()))
        } catch (error) {
          jobs.push(Promise.reject(error))
        }
      }
      try {
        // Interrupt admission's durable launch guard before enumerating its resources.
        attempt(() => options.interrupt(botId))
        attempt(() => options.revokeCredentials(botId))
        const workspaces = db
          .prepare('SELECT id,runtime FROM workspaces WHERE owner_id=? ORDER BY id')
          .all(botId) as Array<{ id: string; runtime: string }>
        for (const workspace of workspaces) {
          attempt(() => options.closeForwards(workspace.id))
          const sessions = db
            .prepare('SELECT id FROM sessions WHERE workspace_id=? ORDER BY id')
            .all(workspace.id) as Array<{ id: string }>
          for (const session of sessions) attempt(() => options.stopSession(session.id))
          attempt(() => options.stopTerminals(workspace.id))
          if (workspace.runtime === 'container') attempt(() => options.stopWorkspace(workspace.id))
        }
      } catch (error) {
        jobs.push(Promise.reject(error))
      }
      try {
        const results = await Promise.allSettled(jobs)
        if (results.some((result) => result.status === 'rejected')) {
          throw new Error(
            'Bot execution remains blocked because some resources could not stop. Retry cleanup before continuing.'
          )
        }
        blocked.delete(botId)
      } finally {
        if (pending.get(botId) === task) pending.delete(botId)
      }
    })
    pending.set(botId, task)
    return task
  }

  return {
    change(botId: string, mustStop: boolean, notify: () => void): Promise<void> {
      if (mustStop || blocked.has(botId)) return stop(botId).finally(notify)
      notify()
      return Promise.resolve()
    },
    releaseRecovered(botIds: readonly string[]): void {
      for (const botId of botIds) {
        const unsettled = db
          .prepare("SELECT 1 FROM workspaces WHERE owner_id=? AND power_state<>'stopped' LIMIT 1")
          .get(botId)
        if (!pending.has(botId) && unsettled === undefined) blocked.delete(botId)
      }
    },
    async idle(): Promise<void> {
      await Promise.allSettled([...pending.values()])
    }
  }
}
