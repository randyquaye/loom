import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { createBotQuiescence } from '../src/main/bots/quiescence'

const databases: ReturnType<typeof openDb>[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function deferred() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
function fixture(initiallyBlocked = false) {
  const db = openDb(':memory:')
  databases.push(db)
  db.exec("INSERT INTO users(id,email,created_at) VALUES ('bot','bot@loom.invalid',0)")
  db.exec(
    "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES ('bot','member','bot','active',0)"
  )
  db.exec("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project','/fixture',0)")
  for (const id of ['a', 'b']) {
    db.prepare(
      "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id,runtime,power_state) VALUES (?,'p',?,?,?,0,'bot','container','running')"
    ).run(id, id, `loom/${id}`, `/fixture/${id}`)
    db.prepare(
      "INSERT INTO sessions(id,workspace_id,backend,model,effort,title,created_at) VALUES (?,?,'codex','gpt-6.1-sol','high','Session',0)"
    ).run(`session-${id}`, id)
  }
  const blocked = new Set(initiallyBlocked ? ['bot'] : [])
  const operations = {
    interrupt: vi.fn(),
    revokeCredentials: vi.fn(),
    closeForwards: vi.fn(),
    stopSession: vi.fn(),
    stopTerminals: vi.fn(),
    stopWorkspace: vi.fn(async (_workspaceId: string) => {})
  }
  const service = createBotQuiescence({ db, blocked, ...operations })
  return { db, blocked, service, ...operations }
}

describe('bot execution quiescence fence', () => {
  it('denies execution before asynchronous stops and releases only after every resource has stopped', async () => {
    const f = fixture()
    const gate = deferred()
    const notify = vi.fn()
    f.stopWorkspace.mockImplementation(async () => gate.wait)
    const stopping = f.service.change('bot', true, notify)
    expect(f.blocked.has('bot')).toBe(true)
    await vi.waitFor(() => expect(f.stopWorkspace).toHaveBeenCalledTimes(2))
    expect(notify).not.toHaveBeenCalled()
    expect(f.blocked.has('bot')).toBe(true)
    gate.release()
    await stopping
    expect(f.blocked.has('bot')).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('attempts all resources and notifies even when one session and one container cannot stop', async () => {
    const f = fixture()
    const notify = vi.fn()
    f.stopSession.mockImplementation((id: string) => {
      if (id === 'session-a') throw new Error('Session cleanup failed')
    })
    f.stopWorkspace.mockImplementation(async (id) => {
      if (id === 'a') throw new Error('Container cleanup failed')
    })
    await expect(f.service.change('bot', true, notify)).rejects.toThrow(/blocked/i)
    expect(f.blocked.has('bot')).toBe(true)
    expect(f.closeForwards.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    expect(f.stopSession.mock.calls.map(([id]) => id)).toEqual(['session-a', 'session-b'])
    expect(f.stopTerminals.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    expect(f.stopWorkspace.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
    expect(f.revokeCredentials).toHaveBeenCalledWith('bot')
    expect(notify).toHaveBeenCalledTimes(1)
    f.stopSession.mockReset()
    f.stopWorkspace.mockResolvedValue(undefined)
    await f.service.change('bot', false, notify)
    expect(f.blocked.has('bot')).toBe(false)
    expect(f.stopWorkspace).toHaveBeenCalledTimes(4)
  })

  it('coalesces racing changes without reopening admission while a shared stop is pending', async () => {
    const f = fixture()
    const gate = deferred()
    const notify = vi.fn()
    f.stopWorkspace.mockImplementation(async () => gate.wait)
    const first = f.service.change('bot', true, notify)
    await vi.waitFor(() => expect(f.stopWorkspace).toHaveBeenCalledTimes(2))
    const second = f.service.change('bot', true, notify)
    const metadata = f.service.change('bot', false, notify)
    expect(f.blocked.has('bot')).toBe(true)
    expect(f.stopWorkspace).toHaveBeenCalledTimes(2)
    gate.release()
    await Promise.all([first, second, metadata])
    expect(f.stopWorkspace).toHaveBeenCalledTimes(2)
    expect(f.blocked.has('bot')).toBe(false)
    expect(notify).toHaveBeenCalledTimes(3)
  })

  it('retains startup denial until old bot containers are confirmed removed', () => {
    const f = fixture(true)
    f.db.prepare("UPDATE workspaces SET power_state='error' WHERE id='a'").run()
    f.service.releaseRecovered(['bot'])
    expect(f.blocked.has('bot')).toBe(true)
    f.db.prepare("UPDATE workspaces SET power_state='stopped',power_error=NULL WHERE owner_id='bot'").run()
    f.service.releaseRecovered(['bot'])
    expect(f.blocked.has('bot')).toBe(false)
  })

  it('does not interrupt authorized previews or processes for ordinary metadata notifications', async () => {
    const f = fixture()
    const notify = vi.fn()
    await f.service.change('bot', false, notify)
    expect(f.blocked.has('bot')).toBe(false)
    expect(f.closeForwards).not.toHaveBeenCalled()
    expect(f.stopWorkspace).not.toHaveBeenCalled()
    expect(f.revokeCredentials).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
