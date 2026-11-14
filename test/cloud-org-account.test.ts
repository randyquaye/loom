import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as SignIn from '../src/main/cloud/sign-in'
import type { RunnerAuth } from '../src/main/cloud/client'
const browserSignIn = vi.hoisted(() => vi.fn())
vi.mock('../src/main/cloud/sign-in', async (original) => ({
  ...(await original<typeof SignIn>()),
  signInThroughBrowser: browserSignIn
}))
import { openCloudAccount, previewInvite } from '../src/main/cloud/account'
import { HostProofError } from '../src/main/cloud/host-proof'
import { TransportProofError } from '../src/main/cloud/transport'

const old = 'wss://old.example.com'
const next = 'https://new.example.com'
const secret = 'a'.repeat(43)
const workEmail = 'ada@company.com'
const trust = { version: 3 as const, domain: 'company.com' }
const code = `loom-invite.v1.${Buffer.from(JSON.stringify({ host: next, secret })).toString('base64url')}`

async function fixture(beforeDelete?: (key: string) => Promise<void>) {
  const saved = new Map([
    ['cloud::runner-url', old],
    [`cloud::refresh-token::${old}`, 'old-refresh']
  ])
  const follows = vi.fn((_url: string, _auth: RunnerAuth) => ({ close: vi.fn(), reconnect: vi.fn() }))
  const account = await openCloudAccount({
    vault: {
      getRaw: async (key) => saved.get(key) ?? null,
      setRaw: async (key, value) => {
        saved.set(key, value)
      },
      deleteRaw: async (key) => {
        await beforeDelete?.(key)
        saved.delete(key)
      }
    },
    environment: {},
    openBrowser: vi.fn(),
    follow: follows
  })
  return { account, saved, follows }
}

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

describe('organization join adoption', () => {
  it.each(['signIn', 'typed'])(
    'preserves the current session on a %s transport-proof failure',
    async (path) => {
      const fx = await fixture()
      fx.saved.set(`cloud::verified-host::${old}`, JSON.stringify(trust))
      browserSignIn.mockRejectedValueOnce(new TransportProofError('TLS rotation is not ready'))
      const operation =
        path === 'signIn' ? fx.account.signIn(workEmail) : fx.account.setRunner(old, workEmail)
      await expect(operation).rejects.toThrow('TLS rotation is not ready')
      expect(fx.saved.get(`cloud::refresh-token::${old}`)).toBe('old-refresh')
      expect(fx.saved.get(`cloud::verified-host::${old}`)).toBe(JSON.stringify(trust))
      expect(fx.follows.mock.results[0]!.value.close).not.toHaveBeenCalled()
      fx.account.close()
    }
  )

  it('finishes blocking a failed current host before adopting another runner', async () => {
    let finishDelete!: () => void
    let deleting = false
    const heldDelete = new Promise<void>((resolve) => {
      finishDelete = resolve
    })
    const fx = await fixture(async (key) => {
      if (key === `cloud::verified-host::${old}`) {
        deleting = true
        await heldDelete
      }
    })
    browserSignIn.mockRejectedValueOnce(new HostProofError('Host proof failed'))
    const failed = fx.account.signIn(workEmail).catch((error: unknown) => error)
    await vi.waitFor(() => expect(deleting).toBe(true))
    browserSignIn.mockResolvedValueOnce({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresIn: 3600,
      trust
    })
    const joined = fx.account.join(code, workEmail)
    await new Promise<void>((resolve) => setImmediate(resolve))
    finishDelete()
    await Promise.all([failed, joined])
    expect(fx.follows.mock.calls.filter(([address]) => address === 'wss://new.example.com')).toHaveLength(1)
    expect(fx.account.runner().url).toBe('wss://new.example.com')
    fx.account.close()
  })

  it('ends a current host connection after its proof fails, without sending another request', async () => {
    const fx = await fixture()
    browserSignIn.mockResolvedValueOnce({
      accessToken: 'verified',
      refreshToken: 'verified-refresh',
      expiresIn: 3600,
      trust
    })
    await fx.account.signIn(workEmail)
    browserSignIn.mockRejectedValueOnce(new HostProofError('Host proof failed'))
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(fx.account.signIn(workEmail)).rejects.toThrow('Host proof failed')
    expect(fx.follows.mock.results[0]!.value.close).toHaveBeenCalledOnce()
    expect(fx.saved.has(`cloud::verified-host::${old}`)).toBe(false)
    await expect(fx.follows.mock.calls[0]![1].token()).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
    fx.account.close()
  })

  it('does not send a pre-proof saved refresh token even when signing out', async () => {
    const fx = await fixture()
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await fx.account.signOut()
    expect(request).not.toHaveBeenCalled()
    expect(fx.saved.has(`cloud::refresh-token::${old}`)).toBe(false)
    fx.account.close()
  })

  it('refuses an empty independently entered email before contacting a new host', async () => {
    const fx = await fixture()
    await expect(fx.account.join(code, '')).rejects.toThrow()
    await expect(fx.account.setRunner(next, '')).rejects.toThrow()
    await expect(fx.account.signIn('')).rejects.toThrow()
    expect(browserSignIn).not.toHaveBeenCalled()
    fx.account.close()
  })

  it('does not trust the earlier host-proof marker after email binding is added', async () => {
    const fx = await fixture()
    fx.saved.set(`cloud::verified-host::${old}`, '1')
    await expect(fx.follows.mock.calls[0]![1].token()).resolves.toBeNull()
    fx.account.close()
  })

  it('does not use a pre-upgrade saved refresh token before host verification', async () => {
    const fx = await fixture()
    const auth = fx.follows.mock.calls[0]![1]
    await expect(auth.token()).resolves.toBeNull()
    expect(fx.saved.get(`cloud::refresh-token::${old}`)).toBe('old-refresh')
    fx.account.close()
  })

  it('enables saved-session use only after a verified sign-in', async () => {
    const fx = await fixture()
    browserSignIn.mockResolvedValueOnce({
      accessToken: 'verified',
      refreshToken: 'new-refresh',
      expiresIn: 3600,
      trust
    })
    await fx.account.signIn(workEmail)
    const auth = fx.follows.mock.calls[0]![1]
    await expect(auth.token()).resolves.toBe('verified')
    expect(JSON.parse(fx.saved.get(`cloud::verified-host::${old}`)!)).toEqual(trust)
    fx.account.close()
  })

  it('refuses developer tokens outside development loopback runners', async () => {
    const vault = { getRaw: async () => null, setRaw: async () => {}, deleteRaw: async () => {} }
    for (const environment of [
      { url: 'wss://remote.example.com', token: 'developer' },
      { url: 'ws://127.0.0.1:3000', token: 'developer' }
    ]) {
      await expect(
        openCloudAccount({ vault, environment, development: false, openBrowser: vi.fn(), follow: vi.fn() })
      ).rejects.toThrow()
    }
    await expect(
      openCloudAccount({
        vault,
        environment: { url: 'wss://remote.example.com', token: 'developer' },
        development: true,
        openBrowser: vi.fn(),
        follow: vi.fn()
      })
    ).rejects.toThrow()
  })

  it('previews an HTTPS host without contacting it, and refuses host URL ambiguity', () => {
    expect(previewInvite(code)).toEqual({ host: next })
    for (const host of [
      'http://new.example.com',
      'https://new.example.com/path',
      'https://person@new.example.com',
      'https://new.example.com/#secret'
    ]) {
      const malformed = `loom-invite.v1.${Buffer.from(JSON.stringify({ host, secret })).toString('base64url')}`
      expect(() => previewInvite(malformed)).toThrow()
    }
    expect(browserSignIn).not.toHaveBeenCalled()
  })

  it('leaves the previous runner and refresh token untouched when host verification fails', async () => {
    const fx = await fixture()
    browserSignIn.mockRejectedValueOnce(new Error('Host proof rejected'))
    await expect(fx.account.join(code, workEmail)).rejects.toThrow('Host proof rejected')
    expect(fx.account.runner().url).toBe(old)
    expect(fx.saved.get('cloud::runner-url')).toBe(old)
    expect(fx.saved.get(`cloud::refresh-token::${old}`)).toBe('old-refresh')
    expect(fx.saved.has('cloud::refresh-token::wss://new.example.com')).toBe(false)
    expect(fx.follows).toHaveBeenCalledTimes(1)
    fx.account.close()
  })

  it('adopts the new host only after its verified browser exchange finishes', async () => {
    const fx = await fixture()
    let finish!: (value: SignIn.Tokens) => void
    browserSignIn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const joining = fx.account.join(code, workEmail)
    expect(fx.account.runner().url).toBe(old)
    finish({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600, trust })
    await joining
    expect(fx.saved.get('cloud::runner-url')).toBe('wss://new.example.com')
    expect(fx.saved.get('cloud::refresh-token::wss://new.example.com')).toBe('new-refresh')
    expect(browserSignIn).toHaveBeenCalledWith(expect.objectContaining({ base: next, inviteSecret: secret }))
    expect(fx.follows).toHaveBeenCalledTimes(2)
    fx.account.close()
  })

  it('cannot adopt a canceled join even if its delayed exchange returns tokens', async () => {
    const fx = await fixture()
    let finish!: (value: SignIn.Tokens) => void
    browserSignIn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const joining = fx.account.join(code, workEmail)
    await fx.account.signOut()
    finish({ accessToken: 'late', refreshToken: 'late', expiresIn: 3600, trust })
    await expect(joining).rejects.toThrow()
    expect(fx.account.runner().url).toBe(old)
    expect(fx.saved.get('cloud::runner-url')).toBe(old)
    expect(fx.follows).toHaveBeenCalledTimes(1)
    fx.account.close()
  })

  it('does not save an operator-typed host when its proof fails', async () => {
    const fx = await fixture()
    browserSignIn.mockRejectedValueOnce(new Error('Host proof rejected'))
    await expect(fx.account.setRunner(next, workEmail)).rejects.toThrow('Host proof rejected')
    expect(fx.account.runner().url).toBe(old)
    expect(fx.saved.get('cloud::runner-url')).toBe(old)
    fx.account.close()
  })
})
