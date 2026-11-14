import type Database from 'better-sqlite3'

interface AdmissionOptions {
  db: Database.Database
  isAdmitted(userId: string): boolean
  maxRunning: number
  minFreeBytes: number
  available(): Promise<number>
}

/** One process owns admission; reserve inside the queue before releasing the next caller. */
export function createRunnerAdmission(options: AdmissionOptions) {
  let draining = false
  let closed = false
  let pending: Promise<unknown> = Promise.resolve()
  const occupied = options.db.prepare(`SELECT COUNT(*) AS count FROM workspaces
    WHERE runtime = 'container' AND (power_state <> 'stopped' OR state IN ('initializing', 'setting_up'))`)

  function assertMember(userId: string): void {
    if (closed) throw new Error('The cloud runner is shutting down')
    if (!options.isAdmitted(userId)) throw new Error('An active organization membership is required')
  }

  function assertNewWork(userId: string): void {
    assertMember(userId)
    if (draining) throw new Error('The cloud runner is draining for maintenance. Try again after the update.')
  }

  function assertWorkspace(workspaceId: string): void {
    if (closed) throw new Error('The cloud runner is shutting down')
    const row = options.db.prepare('SELECT owner_id FROM workspaces WHERE id = ?').get(workspaceId) as
      { owner_id: string | null } | undefined
    if (row?.owner_id === undefined || row.owner_id === null) throw new Error('Workspace has no member owner')
    assertMember(row.owner_id)
  }

  function admit<T>(userId: string, reserve: () => T | Promise<T>): Promise<T> {
    const next = pending
      .catch(() => {})
      .then(async () => {
        assertNewWork(userId)
        const { count } = occupied.get() as { count: number }
        if (count >= options.maxRunning)
          throw new Error('The host is full. Stop a workspace before starting another.')
        if ((await options.available()) < options.minFreeBytes)
          throw new Error(
            'The host has insufficient disk space. Ask an owner to free space or grow the disk.'
          )
        // Membership or drain can change while the filesystem is being inspected.
        assertNewWork(userId)
        return reserve()
      })
    pending = next
    return next
  }

  return {
    assertMember,
    assertNewWork,
    assertWorkspace,
    create: admit,
    start(workspaceId: string, reserve: () => void): Promise<void> {
      if (closed) return Promise.reject(new Error('The cloud runner is shutting down'))
      const row = options.db.prepare('SELECT owner_id FROM workspaces WHERE id = ?').get(workspaceId) as
        { owner_id: string | null } | undefined
      if (!row?.owner_id) return Promise.reject(new Error('Workspace has no member owner'))
      return admit(row.owner_id, reserve)
    },
    setDraining(value: boolean): void {
      draining = value
    },
    draining: () => draining,
    async close(): Promise<void> {
      closed = true
      draining = true
      await pending.catch(() => {})
    }
  }
}

export type RunnerAdmission = ReturnType<typeof createRunnerAdmission>
