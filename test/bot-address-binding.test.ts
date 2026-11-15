import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoginsOptions } from '../src/main/logins/service'
import { openDb } from '../src/main/db'
import { startLoginProxy } from '../src/main/logins/proxy'
import { standInFor } from '../src/main/logins/stand-in'
import type { LoginVault } from '../src/main/logins/vault'
import type * as RuntimeModule from '../src/main/runtime'
import type * as ServerModule from '../src/main/runner/server'

const runtime = vi.hoisted(() => ({
  ownerAt: null as LoginsOptions['ownerAt'] | null,
  addresses: new Map<string, string>(),
  fail: false
}))
vi.mock('../src/main/runtime', async (original) => ({
  ...(await original<typeof RuntimeModule>()),
  discardRuntime: vi.fn(async () => {}),
  removeSignInContainers: vi.fn(async () => {}),
  workspacesByAddress: async () => {
    if (runtime.fail) throw new Error('Docker lookup failed')
    return new Map(runtime.addresses)
  }
}))
vi.mock('../src/main/logins/service', () => ({
  startLogins: async (options: LoginsOptions) => {
    runtime.ownerAt = options.ownerAt
    return {
      port: 0,
      hosts: [],
      secureHome: async () => {},
      close: async () => {},
      revokeAccess: () => {},
      environment: async () => ({}),
      hostGitAccess: async () => ({})
    }
  }
}))
vi.mock('../src/main/runner/server', async (original) => ({
  ...(await original<typeof ServerModule>()),
  startRunnerServer: async () => ({
    port: 0,
    connectedUsers: () => [],
    forwardedWorkspaces: () => [],
    sendTo: () => {},
    closeWhere: () => {},
    closeWorkspaceForwards: () => {},
    close: async () => {}
  })
}))

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  runtime.fail = false
  runtime.addresses.clear()
  runtime.ownerAt = null
})

function deferred() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
const address = '172.18.0.2'
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-bot-binding-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const db = openDb(path.join(root, 'loom.db'))
  for (const [id, kind] of [
    ['bot', 'bot'],
    ['human', 'human']
  ]) {
    db.prepare('INSERT INTO users(id,email,created_at) VALUES (?,?,0)').run(id, `${id}@loom.invalid`)
    db.prepare(
      "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES (?,'member',?,'active',0)"
    ).run(id, kind)
  }
  db.exec("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project','/fixture',0)")
  for (const id of ['bot', 'human']) {
    db.prepare(
      "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,owner_id,runtime) VALUES (?,'p',?,?,?,0,?,'container')"
    ).run(`${id}-workspace`, id, `loom/${id}`, `/fixture/${id}`, id)
  }
  db.close()
  runtime.addresses.set(address, 'bot-workspace')
  const { startRunner } = await import('../src/main/runner/runner')
  const runner = await startRunner({
    dataDir: root,
    secretKey: randomBytes(32),
    host: '127.0.0.1',
    port: 0,
    devIdentities: [{ userId: 'human', email: 'human@loom.invalid', token: 'fixture-human' }],
    placement: { checkout: 'clone', runtime: 'container' },
    allowLocalRemotes: false,
    logins: {
      host: '127.0.0.1',
      port: 0,
      fronts: { claude: 'https://claude.test', codex: 'https://codex.test', github: 'https://github.test' }
    },
    idleMs: 0
  })
  cleanup.push(() => runner.close())
  return runtime.ownerAt!
}

describe('current runtime ownership at the bot credential proxy', () => {
  it.each(['before admission', 'during credential resolution'] as const)(
    'refuses a known bot stand-in when its container address is reassigned %s',
    async (when) => {
      const ownerAt = await fixture()
      // A previous authorized request populated the historical address cache.
      expect(await ownerAt(address)).toEqual({ userId: 'bot', workspaceId: 'bot-workspace' })
      const resolving = deferred()
      const release = deferred()
      const lookup = vi.fn(async () => {
        resolving.release()
        if (when === 'during credential resolution') await release.wait
        return { provider: 'claude' as const, accessToken: 'fixture-canonical-token' }
      })
      let upstreamCalls = 0
      const upstream = createServer((_request, response) => {
        upstreamCalls++
        response.end('provider reached')
      })
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
      cleanup.push(() => new Promise<void>((resolve) => upstream.close(() => resolve())))
      const key = randomBytes(32)
      const proxy = await startLoginProxy({
        host: '127.0.0.1',
        port: 0,
        key,
        isAdmitted: () => true,
        ownerAt,
        vault: { get: lookup, put: async () => {}, remove: async () => {} } as unknown as LoginVault,
        upstreams: { claude: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` }
      })
      cleanup.push(() => proxy.close())
      if (when === 'before admission') runtime.addresses.set(address, 'human-workspace')
      const pending = fetch(`http://127.0.0.1:${proxy.port}/claude/v1/messages`, {
        headers: { authorization: `Bearer ${standInFor(key, 'bot', 'claude')}`, 'x-forwarded-for': address }
      })
      if (when === 'during credential resolution') {
        await resolving.wait
        runtime.addresses.set(address, 'human-workspace')
        release.release()
      }
      expect((await pending).status).toBe(403)
      expect(upstreamCalls).toBe(0)
      expect(lookup).toHaveBeenCalledTimes(when === 'before admission' ? 0 : 1)
    }
  )

  it('returns no owner when Docker lookup fails after an earlier positive ownership result', async () => {
    const ownerAt = await fixture()
    expect(await ownerAt(address)).toEqual({ userId: 'bot', workspaceId: 'bot-workspace' })
    runtime.fail = true
    expect(await ownerAt(address)).toBeNull()
  })
})
