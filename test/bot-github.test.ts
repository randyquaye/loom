import { generateKeyPairSync, randomBytes, verify } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBotGithub } from '../src/main/bots/github'
import { startLogins } from '../src/main/logins/service'
import { standInFor } from '../src/main/logins/stand-in'
import { createLoginVault, type GithubLogin, type SealedStore } from '../src/main/logins/vault'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const credentials = { appId: '1234', installationId: '5678', privateKey }
const permissions = { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function memoryStore() {
  const values = new Map<string, string>()
  const store: SealedStore = {
    getRaw: async (key) => values.get(key) ?? null,
    setRaw: async (key, value) => {
      values.set(key, value)
    },
    deleteRaw: async (key) => {
      values.delete(key)
    }
  }
  return { store, values }
}

function fixture() {
  const saved = memoryStore()
  let at = Date.parse('2026-11-15T05:00:00Z')
  let active = true
  let repositories = ['acme/alpha', 'acme/beta']
  let installationOwner = 'acme'
  let installationId = 5678
  const onRevoked = vi.fn()
  const request = vi.fn<typeof fetch>(async (input, init): Promise<Response> => {
    const url = new URL(String(input))
    if (init?.method === 'POST') {
      return Response.json({
        token: `installation-token-${request.mock.calls.length}`,
        expires_at: new Date(at + 3600_000).toISOString(),
        permissions,
        repositories: repositories.map((full_name) => ({ full_name }))
      })
    }
    expect(url.pathname).toMatch(/^\/repos\/[^/]+\/[^/]+\/installation$/)
    return Response.json({ id: installationId, account: { login: installationOwner } })
  })
  const broker = createBotGithub({
    store: saved.store,
    isAdmitted: () => active,
    isBot: (id) => id === 'robot',
    repositories: () => repositories,
    onRevoked,
    request,
    now: () => at
  })
  return {
    ...saved,
    broker,
    request,
    onRevoked,
    now: () => at,
    advance: (ms: number) => {
      at += ms
    },
    revoke: () => {
      active = false
    },
    repositories: (next: string[]) => {
      repositories = next
    },
    installation: (owner: string, id = 5678) => {
      installationOwner = owner
      installationId = id
    }
  }
}

describe('bot GitHub installation broker', () => {
  it('signs short-lived App JWTs and requests only the verified repositories and permissions', async () => {
    const fx = fixture()
    await fx.broker.configure('robot', credentials)
    expect(await fx.broker.configured('robot')).toBe(true)
    expect(fx.request).not.toHaveBeenCalled()
    const login = await fx.broker.login('robot')
    expect(login).toMatchObject({ provider: 'github', account: 'acme', installed: true })
    expect(fx.request).toHaveBeenCalledTimes(3)
    for (const [input, init] of fx.request.mock.calls) {
      expect(String(input)).toMatch(/^https:\/\/api\.github\.com\//)
      expect(init?.redirect).toBe('error')
      const authorization = new Headers(init?.headers).get('authorization')!
      const jwt = authorization.slice('Bearer '.length)
      const [header, payload, signature] = jwt.split('.')
      expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString())
      expect(claims.iss).toBe('1234')
      expect(claims.iat).toBe(fx.now() / 1000 - 60)
      expect(claims.exp).toBeGreaterThan(fx.now() / 1000)
      expect(claims.exp).toBeLessThanOrEqual(fx.now() / 1000 + 600)
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${payload}`),
          pair.publicKey,
          Buffer.from(signature!, 'base64url')
        )
      ).toBe(true)
    }
    const [url, mint] = fx.request.mock.calls[2]!
    expect(String(url)).toBe('https://api.github.com/app/installations/5678/access_tokens')
    expect(JSON.parse(String(mint?.body))).toEqual({ repositories: ['alpha', 'beta'], permissions })
    expect([...fx.values.keys()]).toEqual(['user::robot::bot-github'])
    expect([...fx.values.values()].join()).not.toContain(login!.accessToken)
  })

  it('shares concurrent resolution and replaces tokens before expiry', async () => {
    const fx = fixture()
    await fx.broker.configure('robot', credentials)
    const [first, second] = await Promise.all([fx.broker.login('robot'), fx.broker.login('robot')])
    expect(first!.accessToken).toBe(second!.accessToken)
    expect(fx.request).toHaveBeenCalledTimes(3)
    fx.advance(10 * 60_000)
    expect((await fx.broker.login('robot'))!.accessToken).toBe(first!.accessToken)
    expect(fx.request).toHaveBeenCalledTimes(3)
    fx.advance(46 * 60_000)
    expect((await fx.broker.login('robot'))!.accessToken).not.toBe(first!.accessToken)
    expect(fx.request).toHaveBeenCalledTimes(6)
  })

  it.each([
    ['other/alpha', 'acme/alpha'],
    ['acme/alpha', 'other/beta']
  ])('refuses mixed installation owners, including duplicate repository names: %j', async (...repos) => {
    const fx = fixture()
    fx.repositories(repos)
    await expect(fx.broker.configure('robot', credentials)).rejects.toThrow(/owner|installation/i)
    expect(fx.request).not.toHaveBeenCalled()
  })

  it.each([
    ['other', 5678],
    ['acme', 9012]
  ] as const)('refuses mismatched installation ownership %s/%s', async (owner, id) => {
    const fx = fixture()
    await fx.broker.configure('robot', credentials)
    fx.installation(owner, id)
    await expect(fx.broker.login('robot')).rejects.toThrow(/installation/i)
    expect(fx.request.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true)
  })

  it('refuses token responses that broaden repository or permission grants', async () => {
    const fx = fixture()
    await fx.broker.configure('robot', credentials)
    fx.request.mockImplementation(async (_input, init) =>
      init?.method === 'POST'
        ? Response.json({
            token: 'broad-token',
            expires_at: new Date(fx.now() + 3600_000).toISOString(),
            permissions: { ...permissions, administration: 'write' },
            repositories: [{ full_name: 'other/alpha' }]
          })
        : Response.json({ id: 5678, account: { login: 'acme' } })
    )
    await expect(fx.broker.login('robot')).rejects.toThrow(/scope|permission|repositories/i)
  })

  it('rejects malformed credentials and human identities without replacing configured access', async () => {
    const fx = fixture()
    await fx.broker.configure('robot', credentials)
    for (const input of [
      { ...credentials, appId: '../1234' },
      { ...credentials, installationId: '5678/access_tokens' },
      { ...credentials, privateKey: 'not a private key' }
    ]) {
      await expect(fx.broker.configure('robot', input)).rejects.toThrow()
    }
    await expect(fx.broker.configure('human', credentials)).rejects.toThrow(/bot/i)
    expect(await fx.broker.configured('robot')).toBe(true)
    expect(await fx.broker.login('human')).toBeNull()
  })

  it.each(['remove', 'invalidate', 'membership', 'repositories'] as const)(
    'fences a token response after %s changes during resolution',
    async (change) => {
      const fx = fixture()
      await fx.broker.configure('robot', credentials)
      const gate = deferred<Response>()
      const minting = deferred<void>()
      fx.request.mockImplementation(async (_input, init) => {
        if (init?.method !== 'POST') return Response.json({ id: 5678, account: { login: 'acme' } })
        minting.resolve()
        return gate.promise
      })
      const pending = fx.broker.login('robot')
      await minting.promise
      if (change === 'remove') await fx.broker.remove('robot')
      else if (change === 'invalidate') fx.broker.invalidate('robot')
      else if (change === 'membership') fx.revoke()
      else fx.repositories(['acme/beta'])
      gate.resolve(
        Response.json({
          token: 'late-token',
          expires_at: new Date(fx.now() + 3600_000).toISOString(),
          permissions,
          repositories: [{ full_name: 'acme/alpha' }, { full_name: 'acme/beta' }]
        })
      )
      expect(await pending).toBeNull()
      if (change === 'remove') expect(await fx.broker.configured('robot')).toBe(false)
    }
  )

  it('serializes deletion behind pending credential writes without restoring removed configuration', async () => {
    const fx = fixture()
    const gate = deferred<void>()
    const writing = deferred<void>()
    const original = fx.store.setRaw
    fx.store.setRaw = async (key, value) => {
      writing.resolve()
      await gate.promise
      await original(key, value)
    }
    const configuring = fx.broker.configure('robot', credentials)
    await writing.promise
    const removing = fx.broker.remove('robot')
    gate.resolve()
    await Promise.allSettled([configuring, removing])
    expect(await fx.broker.configured('robot')).toBe(false)
    expect(await fx.broker.login('robot')).toBeNull()
    expect(fx.onRevoked).toHaveBeenCalledWith('robot')
  })
})

describe('installation credentials in the login facade', () => {
  it.each(['claude', 'codex', 'github'] as const)(
    'fences a pending bot proxy resolution when %s access is disconnected',
    async (provider) => {
      const root = await mkdtemp(path.join(tmpdir(), 'loom-bot-disconnect-'))
      cleanup.push(() => rm(root, { recursive: true, force: true }))
      const reading = deferred<void>()
      const gate = deferred<GithubLogin | null>()
      const key = randomBytes(32)
      const service = await startLogins({
        key,
        store: memoryStore().store,
        host: '127.0.0.1',
        port: 0,
        fronts: { claude: 'https://claude.test', codex: 'https://codex.test', github: 'https://github.test' },
        upstreams: { github: 'http://127.0.0.1:9' },
        botGithub: {
          isBot: (id) => id === 'robot',
          login: async () => {
            reading.resolve()
            return gate.promise
          },
          configured: async () => true,
          remove: async () => {}
        },
        isAdmitted: () => true,
        ownerAt: () => 'robot',
        homeOf: () => path.join(root, 'homes', 'robot')
      })
      cleanup.push(() => service.close())
      const response = fetch(`http://127.0.0.1:${service.port}/github/api/v3/repos/acme/alpha`, {
        headers: { authorization: `Bearer ${standInFor(key, 'robot', 'github')}` }
      })
      await reading.promise
      if (provider === 'github') await service.disconnect('robot', provider)
      else service.revokeAccess('robot')
      gate.resolve(null)
      expect((await response).status).toBe(403)
    }
  )

  it('uses the bot resolver without falling back to personal OAuth or exposing canonical credentials', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-bot-github-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const saved = memoryStore()
    const vault = createLoginVault(saved.store)
    const personal: GithubLogin = {
      provider: 'github',
      accessToken: 'personal-token',
      refreshToken: 'personal-refresh',
      expiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 86400_000,
      account: 'human',
      installed: true,
      clientId: 'personal-client'
    }
    await vault.put('robot', personal)
    await vault.put('human', personal)
    const remove = vi.fn(async () => {})
    const login = vi.fn(async (): Promise<GithubLogin | null> => null)
    const service = await startLogins({
      key: randomBytes(32),
      store: saved.store,
      host: '127.0.0.1',
      port: 0,
      fronts: { claude: 'https://claude.test', codex: 'https://codex.test', github: 'https://github.test' },
      github: {
        clientId: 'personal-client',
        clientSecret: 'secret',
        slug: 'loom',
        publicUrl: 'https://loom.test'
      },
      botGithub: { isBot: (id) => id === 'robot', login, configured: async () => true, remove },
      isAdmitted: () => true,
      ownerAt: () => null,
      homeOf: (id) => path.join(root, id)
    })
    cleanup.push(() => service.close())
    expect((await service.status('robot')).github).toBe(false)
    expect((await service.status('human')).github).toBe(true)
    expect(await service.hostGitAccess('robot')).not.toHaveProperty('GIT_CONFIG_VALUE_3')
    await expect(service.githubExec('robot')).rejects.toThrow(/GitHub/i)
    await expect(service.connectGithub('robot', 'http://127.0.0.1:53211/callback')).rejects.toThrow(
      /installation|bot/i
    )
    await expect(service.finishGithub('robot', 'claim')).rejects.toThrow(/installation|bot/i)
    login.mockResolvedValue({ ...personal, accessToken: 'installation-token', account: 'acme' })
    expect((await service.status('robot')).githubApp).toMatchObject({
      configured: true,
      account: 'acme',
      installUrl: null
    })
    const environment = await service.environment('robot')
    expect(JSON.stringify(environment)).not.toContain('installation-token')
    expect(JSON.stringify(environment)).not.toContain('personal-token')
    expect((await service.hostGitAccess('robot')).GIT_CONFIG_VALUE_3).toContain(
      Buffer.from('x-access-token:installation-token').toString('base64')
    )
    expect((await vault.get('robot', 'github'))!.accessToken).toBe('personal-token')
    await service.disconnect('robot', 'github')
    expect(remove).toHaveBeenCalledWith('robot')
  })
})
