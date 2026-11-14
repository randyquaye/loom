import { afterEach, describe, expect, it, vi } from 'vitest'
const dependencies = vi.hoisted(() => ({
  verify: vi.fn(),
  transport: vi.fn(),
  post: vi.fn(),
  close: vi.fn()
}))
vi.mock('../src/main/cloud/host-proof', async (original) => ({
  ...(await original<object>()),
  verifyHostProof: dependencies.verify
}))
vi.mock('../src/main/cloud/transport', async (original) => ({
  ...(await original<object>()),
  createRunnerTransport: dependencies.transport
}))
import { exchangeSignInCode, requestTokens } from '../src/main/cloud/sign-in'
import { HostProofError } from '../src/main/cloud/host-proof'
import type { RunnerTransport } from '../src/main/cloud/transport'

const input = {
  base: 'https://loom.company-tools.com',
  code: 'one-time-code',
  redirectUri: 'http://127.0.0.1:3000/callback',
  codeVerifier: 'desktop-only-verifier',
  nonce: 'desktop-nonce',
  expectedEmail: 'ada@company.com'
}
const trust = { version: 3, domain: 'company.com' }
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

describe('first sign-in transport binding', () => {
  it.each(['null', '[]', '{'])(
    'refuses malformed sign-in proof %s before the verifier exchange',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body))
      )
      await expect(exchangeSignInCode(input)).rejects.toBeInstanceOf(HostProofError)
      expect(dependencies.transport).not.toHaveBeenCalled()
      expect(dependencies.post).not.toHaveBeenCalled()
    }
  )

  it('reports an incomplete token reply cleanly after the pinned exchange', async () => {
    const transport = {
      post: async () => Response.json(null),
      close: vi.fn(),
      websocketAgent: vi.fn()
    } as RunnerTransport
    await expect(requestTokens(input.base, {}, transport)).rejects.toThrow('incomplete sign-in')
  })

  it('proves the identity without sending PKCE or credentials, then exchanges over authorized TLS', async () => {
    const order: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, options: RequestInit) => {
        order.push('preflight')
        expect(url).toBe(`${input.base}/auth/proof`)
        expect(Object.fromEntries(new URLSearchParams(options.body as URLSearchParams))).toEqual({
          code: input.code,
          redirect_uri: input.redirectUri
        })
        return Response.json({ id_token: 'google-token', host_proof: { host: 'loom.company-tools.com' } })
      })
    )
    dependencies.verify.mockImplementation(async () => {
      order.push('verify')
      return trust
    })
    dependencies.transport.mockReturnValue({ post: dependencies.post, close: dependencies.close })
    dependencies.post.mockImplementation(async () => {
      order.push('pinned-token')
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 })
    })
    await expect(exchangeSignInCode(input)).resolves.toMatchObject({
      accessToken: 'access',
      refreshToken: 'refresh',
      trust
    })
    expect(order).toEqual(['preflight', 'verify', 'pinned-token'])
    expect(dependencies.post).toHaveBeenCalledWith(
      '/auth/token',
      expect.objectContaining({ code_verifier: input.codeVerifier }),
      undefined
    )
    expect(dependencies.close).toHaveBeenCalledOnce()
    const options = dependencies.transport.mock.calls[0]![0] as { trust(): Promise<unknown> }
    await expect(options.trust()).resolves.toEqual(trust)
  })

  it('never sends the verifier when independent host verification fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ id_token: 'wrong-person', host_proof: {} }))
    )
    dependencies.verify.mockRejectedValueOnce(new Error('Identity does not match'))
    await expect(exchangeSignInCode(input)).rejects.toThrow('Identity does not match')
    expect(dependencies.transport).not.toHaveBeenCalled()
    expect(dependencies.post).not.toHaveBeenCalled()
  })
})
