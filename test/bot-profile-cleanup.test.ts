import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotService } from '../src/main/bots/repository'
import { openDb } from '../src/main/db'
import { ensureUser } from '../src/main/db/repos/users'
import { getWorkspaceOrThrow } from '../src/main/db/repos/workspaces'
import { createOrgService } from '../src/main/org/service'
import { createMemberCleanup } from '../src/main/runner/members'
import type * as RuntimeModule from '../src/main/runtime'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import { removeWorkspace } from '../src/main/workspace/bootstrap'
import { robotConfig } from '../src/shared/bots'

const runtime = vi.hoisted(() => ({ discard: vi.fn(async () => {}) }))
vi.mock('../src/main/runtime', async (original) => ({
  ...(await original<typeof RuntimeModule>()),
  discardRuntime: runtime.discard
}))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  runtime.discard.mockReset().mockResolvedValue()
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-bot-profiles-'))
  const db = openDb(':memory:')
  const org = createOrgService(db, { ownerEmail: 'owner@example.com', publicUrl: 'https://loom.example.com' })
  ensureUser(db, { id: 'owner', email: 'owner@example.com' })
  org.admitGoogle('owner', 'owner@example.com', '')
  const bot = createBotService({ db, org }).create('owner', 'robot', {
    ...robotConfig(),
    repositories: ['example/project']
  })
  db.exec("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project','/unused',0)")
  const secrets = createSecretStore(path.join(root, 'secrets.enc'), aesGcmCipher(randomBytes(32)))
  await secrets.setRaw('login::subscription_shared::codex', 'canonical-organization-login')
  cleanups.push(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  async function file(relative: string, value = 'retained') {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, value)
    return target
  }
  async function workspace(id = 'work', ownerId = bot.id) {
    const checkout = path.join(root, 'workspaces', 'project', id.replace(/[^a-z0-9_-]/gi, '_'))
    await mkdir(checkout, { recursive: true })
    await writeFile(path.join(checkout, 'checkout'), 'retained')
    db.prepare(
      `INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,checkout,runtime,owner_id,state)
      VALUES (?,'p',?,?,?,0,'clone','container',?,'ready')`
    ).run(id, id, `loom/${id}`, checkout, ownerId)
    return getWorkspaceOrThrow(db, id)
  }
  return { root, db, org, bot, secrets, file, workspace }
}

describe('isolated bot workspace profile removal', () => {
  it('removes only the deleted bot workspace profile and preserves shared organization credentials', async () => {
    const f = await fixture()
    const workspace = await f.workspace()
    const home = await f.file('homes/bot-workspace-work/private')
    const login = await f.file('login-files/bot-workspace-work/auth.json')
    const other = await f.file('homes/bot-workspace-other/private')
    const human = await f.file('homes/owner/private')
    await removeWorkspace({ db: f.db, repoPath: '/unused', workspace, dataRoot: f.root })
    await expect(readFile(home)).rejects.toThrow()
    await expect(readFile(login)).rejects.toThrow()
    expect(await readFile(other, 'utf8')).toBe('retained')
    expect(await readFile(human, 'utf8')).toBe('retained')
    expect(await f.secrets.getRaw('login::subscription_shared::codex')).toBe('canonical-organization-login')
    expect(f.db.prepare('SELECT id FROM workspaces WHERE id=?').get(workspace.id)).toBeUndefined()
  })

  it('preserves human homes and profile-shaped folders when deleting a human workspace', async () => {
    const f = await fixture()
    const workspace = await f.workspace('human-work', 'owner')
    const home = await f.file('homes/owner/private')
    const matchingName = await f.file('homes/bot-workspace-human-work/private')
    const matchingLogin = await f.file('login-files/bot-workspace-human-work/auth.json')
    await removeWorkspace({ db: f.db, repoPath: '/unused', workspace, dataRoot: f.root })
    for (const target of [home, matchingName, matchingLogin])
      expect(await readFile(target, 'utf8')).toBe('retained')
  })

  it('preserves profiles, checkout, and database identity when the container cannot stop', async () => {
    const f = await fixture()
    const workspace = await f.workspace()
    const home = await f.file('homes/bot-workspace-work/private')
    const login = await f.file('login-files/bot-workspace-work/auth.json')
    runtime.discard.mockRejectedValueOnce(new Error('Container stop failed'))
    await expect(
      removeWorkspace({ db: f.db, repoPath: '/unused', workspace, dataRoot: f.root })
    ).rejects.toThrow('stop failed')
    for (const target of [home, login, path.join(workspace.worktreePath, 'checkout')])
      expect(await readFile(target, 'utf8')).toBe('retained')
    expect(getWorkspaceOrThrow(f.db, workspace.id)).toEqual(workspace)
  })

  it('preserves profiles when checkout removal rejects its path', async () => {
    const f = await fixture()
    const workspace = await f.workspace()
    const home = await f.file('homes/bot-workspace-work/private')
    const rejected = { ...workspace, worktreePath: path.join(f.root, 'not-a-workspace') }
    await expect(
      removeWorkspace({ db: f.db, repoPath: '/unused', workspace: rejected, dataRoot: f.root })
    ).rejects.toThrow(/workspace folder/i)
    expect(await readFile(home, 'utf8')).toBe('retained')
    expect(getWorkspaceOrThrow(f.db, workspace.id)).toEqual(workspace)
  })

  it('refuses profile cleanup that collides with an existing human home namespace', async () => {
    const f = await fixture()
    const workspace = await f.workspace()
    ensureUser(f.db, { id: 'bot-workspace-work', email: 'historical@example.com' })
    f.db.exec(
      "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES ('bot-workspace-work','member','human','active',0)"
    )
    const human = await f.file('homes/bot-workspace-work/private', 'human-data')
    await expect(
      removeWorkspace({ db: f.db, repoPath: '/unused', workspace, dataRoot: f.root })
    ).rejects.toThrow(/reserved|collision|human/i)
    expect(await readFile(human, 'utf8')).toBe('human-data')
    expect(runtime.discard).not.toHaveBeenCalled()
  })

  it('rejects malformed workspace identities before touching any profile or checkout', async () => {
    const f = await fixture()
    const workspace = await f.workspace('../owner')
    const human = await f.file('homes/owner/private')
    await expect(
      removeWorkspace({ db: f.db, repoPath: '/unused', workspace, dataRoot: f.root })
    ).rejects.toThrow(/workspace.*identity|workspace.*id/i)
    expect(await readFile(human, 'utf8')).toBe('retained')
    expect(runtime.discard).not.toHaveBeenCalled()
  })

  it('removes each retained bot profile during member purge without deleting the shared account', async () => {
    const f = await fixture()
    await f.workspace('one')
    await f.workspace('two')
    const profiles = [] as string[]
    for (const id of ['one', 'two']) {
      profiles.push(await f.file(`homes/bot-workspace-${id}/private`))
      profiles.push(await f.file(`login-files/bot-workspace-${id}/auth.json`))
    }
    const cleanup = createMemberCleanup({
      db: f.db,
      org: f.org,
      dataDir: f.root,
      secrets: f.secrets,
      logins: null,
      power: { stopForRemoval: vi.fn(async () => ({ state: 'stopped' as const, error: null })) },
      closeConnections: vi.fn()
    })
    try {
      await cleanup.remove('owner', f.bot.id)
      await cleanup.purgeMember('owner', f.bot.id)
      for (const target of profiles) await expect(readFile(target)).rejects.toThrow()
      expect(f.org.member(f.bot.id)?.purgedAt).not.toBeNull()
      expect(await f.secrets.getRaw('login::subscription_shared::codex')).toBe('canonical-organization-login')
    } finally {
      await cleanup.close()
    }
  })
})
