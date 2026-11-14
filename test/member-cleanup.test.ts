import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { ensureUser } from '../src/main/db/repos/users'
import { createOrgService } from '../src/main/org/service'
import { createMemberCleanup } from '../src/main/runner/members'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'loom-removal-'))
  const db = openDb(':memory:')
  const secrets = createSecretStore(path.join(dataDir, 'secrets.enc'), aesGcmCipher(randomBytes(32)))
  const org = createOrgService(db, { ownerEmail: 'alice@example.com', publicUrl: 'https://loom.example.com' })
  for (const id of ['alice', 'bob']) ensureUser(db, { id, email: `${id}@example.com` })
  org.admitGoogle('alice', 'alice@example.com', 'bootstrap')
  db.prepare(
    "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES ('bob','member','human','active',1)"
  ).run()
  db.prepare("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','p','/unused',1)").run()
  const checkout = path.join(dataDir, 'workspaces', 'p', 'bob')
  await mkdir(checkout, { recursive: true })
  await writeFile(path.join(checkout, 'work.txt'), 'retained')
  db.prepare(
    `INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,checkout,runtime,owner_id,state)
    VALUES ('b','p','b','loom/b',?,1,'clone','container','bob','setting_up')`
  ).run(checkout)
  const stopForRemoval = vi.fn(async () => {
    expect(org.active('bob')).toBe(false)
    db.prepare("UPDATE workspaces SET state='error', power_state='stopped' WHERE id='b'").run()
    return { state: 'stopped' as const, error: null }
  })
  const closeConnections = vi.fn((userId: string) => {
    expect(org.active(userId)).toBe(false)
  })
  const cleanup = createMemberCleanup({
    db,
    dataDir,
    org,
    secrets,
    logins: null,
    power: { stopForRemoval },
    closeConnections
  })
  cleanups.push(async () => {
    await cleanup.close()
    db.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { db, org, cleanup, secrets, checkout, stopForRemoval, closeConnections, dataDir }
}

describe('member removal and retention', () => {
  it('lets owners explicitly purge retained files without changing the removal time', async () => {
    const f = await fixture()
    f.db.prepare("UPDATE workspaces SET runtime='machine', state='ready' WHERE id='b'").run()
    await f.cleanup.remove('alice', 'bob')
    const removedAt = f.org.member('bob')!.removedAt
    await expect(f.cleanup.purgeMember('bob', 'bob')).rejects.toThrow('owner')
    expect(await readFile(path.join(f.checkout, 'work.txt'), 'utf8')).toBe('retained')
    await f.cleanup.purgeMember('alice', 'bob')
    expect(f.org.member('bob')).toMatchObject({ removedAt, purgedAt: expect.any(Number) })
    await expect(readFile(path.join(f.checkout, 'work.txt'))).rejects.toThrow()
  })

  it('defers deletion while detached setup can still write into a checkout', async () => {
    const f = await fixture()
    f.stopForRemoval.mockImplementation(async () => ({ state: 'stopped', error: null }))
    await f.cleanup.remove('alice', 'bob')
    await expect(f.cleanup.purgeMember('alice', 'bob')).rejects.toThrow('setup')
    expect(await readFile(path.join(f.checkout, 'work.txt'), 'utf8')).toBe('retained')
    expect(f.db.prepare("SELECT id FROM workspaces WHERE id='b'").get()).toBeDefined()
    expect(f.org.member('bob')).toMatchObject({ purgeStartedAt: expect.any(Number), purgedAt: null })
    f.db.prepare("UPDATE workspaces SET runtime='machine',state='error' WHERE id='b'").run()
    await f.cleanup.sweep()
    expect(f.org.member('bob')?.purgedAt).not.toBeNull()
  })

  it('revokes membership and connections before stopping setup, retaining files initially', async () => {
    const f = await fixture()
    await f.cleanup.remove('alice', 'bob')
    expect(f.closeConnections).toHaveBeenCalledWith('bob')
    expect(f.stopForRemoval).toHaveBeenCalledWith('b')
    expect(await readFile(path.join(f.checkout, 'work.txt'), 'utf8')).toBe('retained')
    await f.cleanup.sweep()
    expect(f.org.member('bob')?.purgedAt).toBeNull()
  })

  it('purges only overdue personal data and preserves the membership tombstone', async () => {
    const f = await fixture()
    // Machine runtime avoids Docker in this filesystem retention check.
    f.db.prepare("UPDATE workspaces SET runtime='machine',state='ready' WHERE id='b'").run()
    await f.secrets.setRaw('user::bob::env::global::TOKEN', 'bob-value')
    await f.secrets.setRaw('login::bob::codex', 'bob-login')
    await f.secrets.setRaw('user::alice::env::global::TOKEN', 'alice-value')
    for (const folder of ['homes/bob', 'login-files/bob', 'logs/b']) {
      await mkdir(path.join(f.dataDir, folder), { recursive: true })
      await writeFile(path.join(f.dataDir, folder, 'private'), 'private')
    }
    await f.cleanup.remove('alice', 'bob')
    f.db.prepare('UPDATE org_members SET removed_at=? WHERE user_id=?').run(Date.now() - 31 * 86400000, 'bob')
    await f.cleanup.sweep()
    expect(f.db.prepare("SELECT id FROM workspaces WHERE owner_id='bob'").get()).toBeUndefined()
    await expect(readFile(path.join(f.checkout, 'work.txt'))).rejects.toThrow()
    expect(await f.secrets.listRaw('user::bob::')).toEqual([])
    expect(await f.secrets.listRaw('login::bob::')).toEqual([])
    expect(await f.secrets.getRaw('user::alice::env::global::TOKEN')).toBe('alice-value')
    expect(f.org.member('bob')).toMatchObject({
      state: 'removed',
      removedBy: 'alice',
      purgedAt: expect.any(Number)
    })
  })
})
