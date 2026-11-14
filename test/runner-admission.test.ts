import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { ensureUser } from '../src/main/db/repos/users'
import { createRunnerAdmission } from '../src/main/runner/admission'
import { createWorkspacePower } from '../src/main/workspace/power'

const databases: ReturnType<typeof openDb>[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))

function fixture() {
  const db = openDb(':memory:')
  databases.push(db)
  ensureUser(db, { id: 'alice', email: 'alice@example.com' })
  db.prepare('INSERT INTO projects(id,name,repo_path,created_at) VALUES (?,?,?,?)').run('p', 'p', '/tmp/p', 1)
  for (const id of ['a', 'b']) {
    db.prepare(
      `INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,runtime,owner_id,state)
      VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(id, 'p', id, `loom/${id}`, `/tmp/${id}`, 1, 'container', 'alice', 'ready')
  }
  let active = true
  const available = vi.fn(async () => 100)
  const admission = createRunnerAdmission({
    db,
    isAdmitted: () => active,
    maxRunning: 1,
    minFreeBytes: 10,
    available
  })
  const reserve = (id: string) => () => {
    db.prepare("UPDATE workspaces SET power_state = 'starting' WHERE id = ?").run(id)
  }
  return {
    db,
    admission,
    available,
    reserve,
    remove: () => {
      active = false
    }
  }
}

describe('runner admission across asynchronous work', () => {
  it('waits for accepted creation before shutdown and refuses queued or later starts', async () => {
    const f = fixture()
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const created = vi.fn(async () => {
      await paused
      return 'workspace'
    })
    const creating = f.admission.create('alice', created)
    await vi.waitFor(() => expect(created).toHaveBeenCalledOnce())
    let closed = false
    const closing = f.admission.close().then(() => {
      closed = true
    })
    await expect(f.admission.start('a', f.reserve('a'))).rejects.toThrow('shutting down')
    expect(closed).toBe(false)
    release()
    expect(await creating).toBe('workspace')
    await closing
    expect(closed).toBe(true)
  })

  it('reserves capacity before a simultaneous start can pass', async () => {
    const f = fixture()
    const starts = await Promise.allSettled([
      f.admission.start('a', f.reserve('a')),
      f.admission.start('b', f.reserve('b'))
    ])
    expect(starts.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    expect((starts[1] as PromiseRejectedResult).reason.message).toContain('host is full')
  })

  it('rechecks admission after disk IO, before creating or reserving a workspace', async () => {
    const f = fixture()
    f.available.mockImplementation(async () => {
      f.remove()
      return 100
    })
    const create = vi.fn(async () => 'created')
    await expect(f.admission.create('alice', create)).rejects.toThrow('membership')
    expect(create).not.toHaveBeenCalled()
    await expect(f.admission.start('a', f.reserve('a'))).rejects.toThrow('membership')
  })

  it('refuses insufficient disk and recovers after a failed reservation', async () => {
    const f = fixture()
    f.available.mockResolvedValueOnce(9)
    await expect(f.admission.start('a', f.reserve('a'))).rejects.toThrow('disk space')
    await expect(
      f.admission.create('alice', async () => {
        throw new Error('clone refused')
      })
    ).rejects.toThrow('clone refused')
    await expect(f.admission.start('b', f.reserve('b'))).resolves.toBeUndefined()
  })

  it('blocks new work during drain, then resumes without restarting', async () => {
    const f = fixture()
    f.admission.setDraining(true)
    await expect(f.admission.create('alice', async () => 'created')).rejects.toThrow('draining')
    await expect(f.admission.start('a', f.reserve('a'))).rejects.toThrow('draining')
    f.admission.setDraining(false)
    await expect(f.admission.start('a', f.reserve('a'))).resolves.toBeUndefined()
  })

  it('shares the capacity reservation with actual power transitions', async () => {
    const f = fixture()
    const power = createWorkspacePower({
      db: f.db,
      idleMs: 0,
      admitStart: f.admission.start,
      start: async () => {},
      stop: async () => {},
      suspend: () => {},
      changed: () => {},
      signals: {
        busyWorkspaces: () => [],
        terminalIoAt: () => undefined,
        forwardedWorkspaces: () => [],
        runningCommand: async () => false
      }
    })
    try {
      const starts = await Promise.allSettled([power.start('a'), power.start('b')])
      expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(power.status('a').state).toBe('running')
      await power.stop('a')
      await expect(power.start('b')).resolves.toMatchObject({ state: 'running' })
    } finally {
      await power.close()
    }
  })
})
