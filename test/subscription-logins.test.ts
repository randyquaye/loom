import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startLogins, type LoginsOptions } from '../src/main/logins/service'
import { standInFor } from '../src/main/logins/stand-in'
import { createLoginVault, type SealedStore } from '../src/main/logins/vault'
import { SubscriptionIdentityError } from '../src/main/subscriptions/repository'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(provider: 'claude' | 'codex' = 'claude') {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-subscription-logins-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const values = new Map<string, string>()
  let delay: (() => Promise<void>) | undefined
  const store: SealedStore = {
    async getRaw(key) {
      const value = values.get(key) ?? null
      if (key.startsWith('login::subscription_')) await delay?.()
      return value
    },
    async setRaw(key, value, guard) {
      guard?.()
      values.set(key, value)
    },
    async deleteRaw(key, guard) {
      guard?.()
      values.delete(key)
    }
  }
  const accounts = ['a', 'b'].map((id) => ({
    id: `subscription_${id}`,
    provider,
    label: id,
    enabled: true,
    state: 'ready',
    retryAt: null,
    providerResetAt: null,
    lastUsedAt: null,
    assignedWorkspaces: 1
  }))
  const assigned = new Map([
    ['workspace-a', accounts[0]!],
    ['workspace-b', accounts[1]!]
  ])
  const observe = vi.fn()
  const connected = vi.fn()
  const subscriptions = {
    assigned: (bot: string, kind: string, workspace?: string) => {
      const value = bot === 'robot' && kind === provider ? (assigned.get(workspace ?? '') ?? null) : null
      return value?.enabled && value.state === 'ready' ? value : null
    },
    bound: (bot: string, kind: string, workspace?: string) =>
      bot === 'robot' && kind === provider ? (assigned.get(workspace ?? '') ?? null) : null,
    available: (bot: string, kind: string) => bot === 'robot' && kind === provider && assigned.size > 0,
    account: (id: string) => accounts.find((account) => account.id === id) ?? null,
    activeAccount: (id: string) => accounts.find((account) => account.id === id && account.enabled) ?? null,
    isAccount: (id: string) => accounts.some((account) => account.id === id),
    guardAccount: (id: string) => () => {
      if (!accounts.some((account) => account.id === id && account.enabled))
        throw new Error('Account disabled')
    },
    guardRefresh: (id: string, login: { provider: string }) => () => {
      if (!accounts.some((account) => account.id === id && account.provider === login.provider))
        throw new Error('Account removed')
    },
    assertLogin: (id: string, login: { provider: string }) => {
      if (
        !accounts.some(
          (account) => account.id === id && account.enabled && account.provider === login.provider
        )
      )
        throw new Error('Subscription is no longer authorized')
      return () => {}
    },
    connected,
    disconnected: vi.fn(),
    observe
  } as unknown as NonNullable<LoginsOptions['subscriptions']>
  const vault = createLoginVault(store)
  for (const name of ['a', 'b'])
    await vault.put(
      `subscription_${name}`,
      provider === 'claude'
        ? { provider, accessToken: `real-${name}` }
        : {
            provider,
            accessToken: `real-${name}`,
            refreshToken: 'refresh',
            idToken: 'id',
            accountId: `account-${name}`
          }
    )
  // These obsolete bot credentials must never become a fallback.
  await vault.put('robot', { provider: 'claude', accessToken: 'obsolete-bot-token' })
  const seen: Array<{ authorization: string | undefined; account: string | string[] | undefined }> = []
  let status = 200
  let beforeResponse: (() => void) | undefined
  const server = createServer((request, response) => {
    seen.push({
      authorization: request.headers.authorization,
      account: request.headers['chatgpt-account-id']
    })
    beforeResponse?.()
    response.writeHead(status, { 'retry-after': '73' }).end('fixture')
  })
  const sockets = new WebSocketServer({ noServer: true })
  let frames = 0
  server.on('upgrade', (request, socket, head) => {
    seen.push({
      authorization: request.headers.authorization,
      account: request.headers['chatgpt-account-id']
    })
    if (status !== 101) {
      socket.end(`HTTP/1.1 ${status} Limited\r\nRetry-After: 73\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      sockets.emit('connection', ws, request)
      ws.on('message', (message) => {
        frames++
        ws.send(message)
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    for (const client of sockets.clients) client.terminate()
    sockets.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const key = randomBytes(32)
  let workspaceId = 'workspace-a'
  let ownerDelay: (() => Promise<void>) | undefined
  const signIn = vi.fn()
  const logins = await startLogins({
    key,
    store,
    host: '127.0.0.1',
    port: 0,
    subscriptions,
    fronts: { claude: upstream, codex: upstream, github: upstream },
    upstreams: { claude: upstream, codex: upstream },
    isAdmitted: (id) => id === 'robot' || id === 'human',
    ownerAt: async () => {
      await ownerDelay?.()
      return { userId: 'robot', workspaceId }
    },
    homeOf: (id) => path.join(root, 'homes', id),
    signInToCodex: signIn,
    botGithub: { isBot: (id) => id === 'robot', login: async () => null, configured: async () => false }
  })
  cleanup.push(() => logins.close())
  return {
    root,
    logins,
    vault,
    subscriptions,
    assigned,
    accounts,
    observe,
    connected,
    seen,
    signIn,
    base: `http://127.0.0.1:${logins.port}`,
    headers: { authorization: `Bearer ${standInFor(key, 'robot', provider)}` },
    move: (id: string) => {
      workspaceId = id
    },
    limit: (code: number) => {
      status = code
    },
    beforeResponse: (run: () => void) => {
      beforeResponse = run
    },
    delay: (read: () => Promise<void>) => {
      delay = read
    },
    delayOwner: (read: () => Promise<void>) => {
      ownerDelay = read
    },
    frames: () => frames
  }
}

describe('organization subscription credential resolution', () => {
  it('does not revive requests revoked during the initial workspace address lookup', async () => {
    const fx = await fixture()
    const reading = deferred<void>()
    const gate = deferred<void>()
    fx.delayOwner(async () => {
      reading.resolve()
      await gate.promise
    })
    const answer = fetch(`${fx.base}/claude/v1/messages`, { headers: fx.headers })
    await reading.promise
    fx.logins.revokeAccess('robot')
    gate.resolve()
    expect((await answer).status).toBe(403)
    expect(fx.seen).toHaveLength(0)
  })

  it('uses the exact workspace binding and never falls back to bot-owned credentials', async () => {
    const fx = await fixture()
    expect((await fetch(`${fx.base}/claude/v1/messages`, { headers: fx.headers })).status).toBe(200)
    fx.move('workspace-b')
    expect((await fetch(`${fx.base}/claude/v1/messages`, { headers: fx.headers })).status).toBe(200)
    expect(fx.seen.map((request) => request.authorization)).toEqual(['Bearer real-a', 'Bearer real-b'])
    fx.assigned.delete('workspace-b')
    expect((await fetch(`${fx.base}/claude/v1/messages`, { headers: fx.headers })).status).toBe(503)
    expect(fx.seen).toHaveLength(2)
  })

  it.each(['binding', 'address'] as const)(
    'fences %s changes during delayed account reads',
    async (change) => {
      const fx = await fixture()
      const reading = deferred<void>()
      const gate = deferred<void>()
      fx.delay(async () => {
        reading.resolve()
        await gate.promise
      })
      const answer = fetch(`${fx.base}/claude/v1/messages`, { headers: fx.headers })
      await Promise.race([reading.promise, answer])
      if (change === 'binding') fx.assigned.delete('workspace-a')
      else fx.move('workspace-b')
      gate.resolve()
      expect((await answer).status).toBe(change === 'address' ? 403 : 503)
      expect(fx.seen).toHaveLength(0)
    }
  )

  it('reports HTTP throttling against the requesting binding without replay', async () => {
    const fx = await fixture()
    fx.limit(429)
    expect((await fetch(`${fx.base}/claude/v1/messages`, { headers: fx.headers })).status).toBe(429)
    expect(fx.observe).toHaveBeenCalledWith(
      'robot',
      'claude',
      'workspace-a',
      429,
      expect.objectContaining({ 'retry-after': '73' }),
      expect.any(Function)
    )
    expect(fx.seen).toHaveLength(1)
  })

  it.each(['http', 'websocket'] as const)(
    'reports cooldown as %s capacity throttling instead of lost authentication',
    async (transport) => {
      const fx = await fixture('codex')
      Object.assign(fx.accounts[0]!, { state: 'rate_limited', retryAt: Date.now() + 90000 })
      if (transport === 'http') {
        const answer = await fetch(`${fx.base}/codex/backend-api/codex/responses`, { headers: fx.headers })
        expect(answer.status).toBe(429)
        expect(Number(answer.headers.get('retry-after'))).toBeGreaterThanOrEqual(89)
      } else {
        const socket = new WebSocket(`${fx.base.replace('http:', 'ws:')}/codex/backend-api/codex/responses`, {
          headers: fx.headers
        })
        cleanup.push(async () => {
          socket.terminate()
        })
        await new Promise<void>((resolve, reject) => {
          socket.on('unexpected-response', (_request, response) => {
            try {
              expect(response.statusCode).toBe(429)
              expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(89)
              resolve()
            } catch (error) {
              reject(error)
            }
            response.resume()
            socket.terminate()
          })
          socket.on('error', () => {})
          socket.on('open', () => reject(new Error('Unavailable account was admitted')))
        })
      }
      expect(fx.seen).toHaveLength(0)
    }
  )

  it('returns unavailable capacity for a disabled pinned account without erasing Codex identity', async () => {
    const fx = await fixture('codex')
    Object.assign(fx.accounts[0]!, { enabled: false })
    expect(
      (await fetch(`${fx.base}/codex/backend-api/codex/responses`, { headers: fx.headers })).status
    ).toBe(503)
    const home = fx.logins.workspaceHome('robot', 'workspace-a')
    await fx.logins.secureHome('robot', home, 'workspace-a')
    const source = path.join(fx.root, 'login-files', path.basename(home), '.codex/auth.json')
    expect(JSON.parse(await readFile(source, 'utf8')).tokens.account_id).toBe('account-a')
    expect(fx.seen).toHaveLength(0)
  })

  it('preserves mounted Codex stand-ins when starting during account cooldown', async () => {
    const fx = await fixture('codex')
    Object.assign(fx.accounts[0]!, { state: 'rate_limited', retryAt: Date.now() + 90000 })
    const home = fx.logins.workspaceHome('robot', 'workspace-a')
    await fx.logins.secureHome('robot', home, 'workspace-a')
    const contents = await readFile(
      path.join(fx.root, 'login-files', path.basename(home), '.codex/auth.json'),
      'utf8'
    )
    expect(JSON.parse(contents).tokens.account_id).toBe('account-a')
    expect(contents).not.toMatch(/real-a|"refresh"/)
    expect(
      (await fetch(`${fx.base}/codex/backend-api/codex/responses`, { headers: fx.headers })).status
    ).toBe(429)
  })

  it('reads disabled account status without renewing canonical credentials', async () => {
    const fx = await fixture('codex')
    const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`
    await fx.vault.put('subscription_a', {
      provider: 'codex',
      accessToken: expired,
      refreshToken: 'refresh',
      idToken: 'id',
      accountId: 'account-a'
    })
    Object.assign(fx.accounts[0]!, { enabled: false })
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    expect((await fx.logins.status('subscription_a')).codex).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('does not serve an expired pooled token when refresh is temporarily unavailable', async () => {
    const fx = await fixture('codex')
    const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`
    await fx.vault.put('subscription_a', {
      provider: 'codex',
      accessToken: expired,
      refreshToken: 'refresh',
      idToken: 'id',
      accountId: 'account-a'
    })
    const request = globalThis.fetch
    vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      new URL(String(input)).hostname === 'auth.openai.com'
        ? Promise.resolve(new Response('', { status: 503 }))
        : request(input, init)
    )
    expect(
      (await fetch(`${fx.base}/codex/backend-api/codex/responses`, { headers: fx.headers })).status
    ).toBe(503)
    expect(fx.seen).toHaveLength(0)
    expect(fx.observe).not.toHaveBeenCalled()
    expect((await fx.vault.get('subscription_a', 'codex'))?.accessToken).toBe(expired)
  })

  it('ignores authentication failures returned after the admitted pooled token expires', async () => {
    const fx = await fixture('codex')
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const accessToken = `header.${Buffer.from(JSON.stringify({ exp: expiresAt })).toString('base64url')}.signature`
    await fx.vault.put('subscription_a', {
      provider: 'codex',
      accessToken,
      refreshToken: 'refresh',
      idToken: 'id',
      accountId: 'account-a'
    })
    fx.limit(401)
    fx.beforeResponse(() => vi.spyOn(Date, 'now').mockReturnValue((expiresAt + 1) * 1000))
    expect(
      (await fetch(`${fx.base}/codex/backend-api/codex/responses`, { headers: fx.headers })).status
    ).toBe(401)
    expect(fx.observe).not.toHaveBeenCalled()
  })

  it.each([
    ['claude', '/v1/messages/count_tokens', 401],
    ['codex', '/backend-api/codex/models', 401],
    ['claude', '/v1/messages/count_tokens', 429],
    ['codex', '/backend-api/codex/models', 429]
  ] as const)(
    'does not treat auxiliary %s endpoint failures (%s, %s) as account loss',
    async (provider, endpoint, status) => {
      const fx = await fixture(provider)
      fx.limit(status)
      expect((await fetch(`${fx.base}/${provider}${endpoint}`, { headers: fx.headers })).status).toBe(status)
      expect(fx.observe).not.toHaveBeenCalled()
      expect(fx.seen).toHaveLength(1)
    }
  )

  it.each([429, 101])(
    'observes Codex upgrade status %i and forwards each accepted frame once',
    async (status) => {
      const fx = await fixture('codex')
      fx.limit(status)
      const socket = new WebSocket(`${fx.base.replace('http:', 'ws:')}/codex/backend-api/codex/responses`, {
        headers: fx.headers
      })
      cleanup.push(async () => {
        socket.terminate()
      })
      if (status === 429)
        await new Promise<void>((resolve, reject) => {
          socket.on('unexpected-response', (_request, response) => {
            response.resume()
            socket.terminate()
            resolve()
          })
          socket.on('error', () => {})
          socket.on('open', () => reject(new Error('The rejected handshake was accepted')))
        })
      else {
        await new Promise<void>((resolve, reject) => {
          socket.once('open', resolve)
          socket.once('error', reject)
        })
        const answer = new Promise<string>((resolve) =>
          socket.once('message', (data) => resolve(data.toString()))
        )
        socket.send('one frame')
        expect(await answer).toBe('one frame')
        expect(fx.frames()).toBe(1)
      }
      expect(fx.observe).toHaveBeenCalledWith(
        'robot',
        'codex',
        'workspace-a',
        status,
        expect.any(Object),
        expect.any(Function)
      )
      expect(fx.seen).toEqual([{ authorization: 'Bearer real-a', account: 'account-a' }])
    }
  )

  it('isolates mounted Codex identities by workspace while keeping real tokens host-only', async () => {
    const fx = await fixture('codex')
    for (const workspace of ['workspace-a', 'workspace-b']) {
      const home = fx.logins.workspaceHome('robot', workspace)
      expect(home).toBe(path.join(fx.root, 'homes', `bot-workspace-${workspace}`))
      await fx.logins.secureHome('robot', home, workspace)
      const contents = await readFile(
        path.join(fx.root, 'login-files', path.basename(home), '.codex', 'auth.json'),
        'utf8'
      )
      expect(JSON.parse(contents).tokens.account_id).toBe(`account-${workspace.at(-1)}`)
      expect(contents).not.toMatch(/real-[ab]|"refresh"/)
    }
    expect(fx.logins.workspaceHome('human', 'workspace-a')).toBe(path.join(fx.root, 'homes', 'human'))
  })

  it('rejects bot subscription sign-ins and connects organization accounts without creating account homes', async () => {
    const fx = await fixture()
    await expect(fx.logins.connectClaude('robot', 'sk-ant-fixture-token-123456789')).rejects.toThrow(
      /organization|subscription/i
    )
    await expect(fx.logins.connectCodex('robot')).rejects.toThrow(/organization|subscription/i)
    expect(fx.signIn).not.toHaveBeenCalled()
    await fx.logins.connectClaude('subscription_a', 'sk-ant-fixture-token-123456789')
    expect(fx.connected).toHaveBeenCalledWith(
      'subscription_a',
      expect.objectContaining({ provider: 'claude' })
    )
    await expect(
      readFile(path.join(fx.root, 'homes', 'subscription_a', '.codex', 'auth.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports controlled Codex account identity errors without replacing the canonical login', async () => {
    const fx = await fixture('codex')
    const home = path.join(fx.root, 'isolated-sign-in')
    await mkdir(path.join(home, '.codex'), { recursive: true })
    await writeFile(
      path.join(home, '.codex/auth.json'),
      JSON.stringify({
        tokens: {
          access_token: 'new-fixture-token',
          refresh_token: 'new-fixture-refresh',
          id_token: 'fixture-id',
          account_id: 'duplicate-account'
        }
      })
    )
    const completion = deferred<number>()
    fx.signIn.mockResolvedValue({
      home,
      output: (async function* () {
        yield 'https://auth.openai.com/fixture\nABCD-EFGH\n'
      })(),
      done: completion.promise,
      cancel() {},
      discard: async () => {}
    })
    const message = 'This subscription account is already connected under another label'
    vi.spyOn(fx.subscriptions, 'assertLogin').mockImplementation(() => {
      throw new SubscriptionIdentityError(message)
    })
    await fx.logins.connectCodex('subscription_a')
    completion.resolve(0)
    await expect
      .poll(async () => (await fx.logins.status('subscription_a')).attempts?.codex?.state)
      .toBe('failed')
    expect((await fx.logins.status('subscription_a')).attempts?.codex?.message).toBe(message)
    expect((await fx.vault.get('subscription_a', 'codex'))?.accessToken).toBe('real-a')
  })
})
