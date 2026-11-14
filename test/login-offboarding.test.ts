import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startLoginProxy } from '../src/main/logins/proxy'
import { startLogins } from '../src/main/logins/service'
import { standInFor, type LoginProvider } from '../src/main/logins/stand-in'
import { createLoginVault, type LoginVault, type SealedStore } from '../src/main/logins/vault'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllGlobals()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function store(): SealedStore {
  const values = new Map<string, string>()
  return {
    getRaw: async (key) => values.get(key) ?? null,
    setRaw: async (key, value) => {
      values.set(key, value)
    },
    deleteRaw: async (key) => {
      values.delete(key)
    }
  }
}
async function fixture(delayed = false) {
  let active = true
  let owner = 'ada'
  let seen = 0
  const gate = deferred<void>()
  const reading = deferred<void>()
  const streamClosed = deferred<void>()
  const server = createServer((_request, response) => {
    seen++
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: pending\n\n')
    response.on('close', () => streamClosed.resolve())
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', () => {
    seen++
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    for (const socket of sockets.clients) socket.terminate()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const key = randomBytes(32)
  const kept = createLoginVault(store())
  await kept.put('ada', { provider: 'claude', accessToken: 'real-claude-token' })
  await kept.put('ada', {
    provider: 'codex',
    accessToken: 'real-codex-token',
    refreshToken: 'refresh',
    idToken: 'id',
    accountId: 'account'
  })
  const vault: LoginVault = {
    ...kept,
    async get<P extends LoginProvider>(userId: string, provider: P) {
      if (delayed) {
        reading.resolve()
        await gate.promise
      }
      return kept.get(userId, provider)
    }
  }
  const proxy = await startLoginProxy({
    host: '127.0.0.1',
    port: 0,
    key,
    vault,
    isAdmitted: () => active,
    ownerAt: () => owner,
    upstreams: { claude: upstream, codex: upstream }
  })
  cleanup.push(() => proxy.close())
  return {
    proxy,
    gate,
    reading,
    streamClosed,
    seen: () => seen,
    remove: () => {
      active = false
    },
    move: () => {
      owner = 'bob'
    },
    headers: (provider: LoginProvider) => ({ authorization: `Bearer ${standInFor(key, 'ada', provider)}` }),
    base: `http://127.0.0.1:${proxy.port}`
  }
}

describe('member offboarding at the login proxy', () => {
  it.each(['membership', 'ownership'] as const)(
    'rechecks %s after a delayed credential read',
    async (change) => {
      const fx = await fixture(true)
      const response = fetch(`${fx.base}/claude/v1/messages`, { headers: fx.headers('claude') })
      await fx.reading.promise
      if (change === 'membership') fx.remove()
      else fx.move()
      fx.gate.resolve()
      expect((await response).status).toBe(403)
      expect(fx.seen()).toBe(0)
    }
  )

  it('does not revive an in-flight request when a removed member rejoins', async () => {
    const fx = await fixture(true)
    const response = fetch(`${fx.base}/claude/v1/messages`, { headers: fx.headers('claude') })
    await fx.reading.promise
    fx.proxy.closeFor('ada')
    fx.gate.resolve()
    expect((await response).status).toBe(403)
    expect(fx.seen()).toBe(0)
  })

  it('closes a live HTTP provider stream when access ends', async () => {
    const fx = await fixture()
    const response = await fetch(`${fx.base}/claude/v1/messages`, { headers: fx.headers('claude') })
    const reader = response.body!.getReader()
    await reader.read()
    const ended = reader.read().then(
      (result) => result.done,
      () => true
    )
    fx.proxy.closeFor('ada')
    expect(await ended).toBe(true)
    await fx.streamClosed.promise
  })

  it('closes a live WebSocket provider stream when access ends', async () => {
    const fx = await fixture()
    const socket = new WebSocket(`${fx.base.replace('http:', 'ws:')}/codex/backend-api/codex/responses`, {
      headers: fx.headers('codex')
    })
    cleanup.push(async () => socket.terminate())
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    fx.proxy.closeFor('ada')
    await closed
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  })
})

it('forgets provider logins without recreating homes or allowing a late renewal to restore them', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-forget-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const saved = store()
  const vault = createLoginVault(saved)
  await vault.put('ada', { provider: 'claude', accessToken: 'claude' })
  await vault.put('ada', {
    provider: 'codex',
    accessToken: 'codex',
    refreshToken: 'codex-refresh',
    idToken: 'id',
    accountId: 'account'
  })
  await vault.put('ada', {
    provider: 'github',
    accessToken: 'github',
    refreshToken: 'github-refresh',
    expiresAt: 0,
    refreshExpiresAt: Date.now() + 60000,
    account: 'ada',
    installed: true,
    clientId: 'client'
  })
  const renewal = deferred<Response>()
  const renewing = deferred<void>()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      renewing.resolve()
      return renewal.promise
    })
  )
  let active = true
  const service = await startLogins({
    key: randomBytes(32),
    store: saved,
    host: '127.0.0.1',
    port: 0,
    fronts: { claude: 'https://claude.test', codex: 'https://codex.test', github: 'https://github.test' },
    isAdmitted: () => active,
    ownerAt: () => null,
    homeOf: () => path.join(root, 'homes', 'ada'),
    github: { clientId: 'client', clientSecret: 'secret', slug: 'loom', publicUrl: 'https://loom.test' }
  })
  cleanup.push(() => service.close())
  const status = service.status('ada')
  await renewing.promise
  active = false
  await service.forget('ada')
  renewal.resolve(
    Response.json({
      access_token: 'late-renewed',
      refresh_token: 'late-refresh',
      expires_in: 3600,
      refresh_token_expires_in: 86400
    })
  )
  await status
  for (const provider of ['claude', 'codex', 'github'] as const)
    expect(await vault.get('ada', provider)).toBeNull()
  await expect(stat(path.join(root, 'homes', 'ada'))).rejects.toMatchObject({ code: 'ENOENT' })
})
