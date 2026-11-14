import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const requests = vi.hoisted(() => ({ renew: vi.fn(), signIn: vi.fn(), revoke: vi.fn() }))
vi.mock('../src/main/cloud/sign-in', async (original) => ({
  ...(await original<object>()),
  requestTokens: requests.renew,
  signInThroughBrowser: requests.signIn,
  revokeRefreshToken: requests.revoke
}))
import { createCloudSession } from '../src/main/cloud/session'
import type { Tokens } from '../src/main/cloud/sign-in'

const fresh: Tokens = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 }

function fixture() {
  let saved: string | null = 'old-refresh'
  const session = createCloudSession({
    runnerUrl: 'wss://loom.example.com',
    openBrowser: vi.fn(),
    store: {
      get: async () => saved,
      set: async (token) => {
        saved = token
      },
      clear: async () => {
        saved = null
      }
    }
  })
  return { session, saved: () => saved }
}

afterEach(() => vi.resetAllMocks())
beforeEach(() => requests.revoke.mockResolvedValue(undefined))

describe('desktop cloud-session lifecycle', () => {
  it('cannot restore credentials from a refresh that completes after sign-out', async () => {
    const fx = fixture()
    let finish!: (tokens: Tokens) => void
    requests.renew.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const renewing = fx.session.accessToken()
    await vi.waitFor(() => expect(requests.renew).toHaveBeenCalledOnce())
    await fx.session.signOut()
    finish(fresh)
    await renewing
    expect(fx.saved()).toBeNull()
    await expect(fx.session.accessToken()).resolves.toBeNull()
  })

  it('cannot replace a newly verified sign-in with an older delayed refresh', async () => {
    const fx = fixture()
    let finish!: (tokens: Tokens) => void
    requests.renew.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const renewing = fx.session.accessToken()
    await vi.waitFor(() => expect(requests.renew).toHaveBeenCalledOnce())
    requests.signIn.mockResolvedValueOnce(fresh)
    await fx.session.signIn('ada@company.com')
    finish({ accessToken: 'stale-access', refreshToken: 'stale-refresh', expiresIn: 3600 })
    await renewing
    expect(fx.saved()).toBe('new-refresh')
    await expect(fx.session.accessToken()).resolves.toBe('new-access')
  })

  it('clears an already-started vault write before sign-out finishes', async () => {
    let saved: string | null = 'old-refresh'
    let finishWrite!: () => void
    const set = vi.fn(async (token: string) => {
      await new Promise<void>((resolve) => {
        finishWrite = resolve
      })
      saved = token
    })
    const session = createCloudSession({
      runnerUrl: 'wss://loom.example.com',
      openBrowser: vi.fn(),
      store: {
        get: async () => saved,
        set,
        clear: async () => {
          saved = null
        }
      }
    })
    requests.renew.mockResolvedValueOnce(fresh)
    const renewing = session.accessToken()
    await vi.waitFor(() => expect(set).toHaveBeenCalledOnce())
    const signingOut = session.signOut()
    finishWrite()
    await Promise.all([renewing, signingOut])
    expect(saved).toBeNull()
    await expect(session.accessToken()).resolves.toBeNull()
  })
})
