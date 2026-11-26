import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { verifyHostProof } from '../src/main/cloud/host-proof'
import { verifyTransportProof } from '../src/main/cloud/transport'
import type { HostProof, TransportProof } from '../src/shared/org'

interface NativeFixture {
  now: number
  base: string
  domain: string
  expectedEmail: string
  nonce: string
  jwks: unknown
  idToken: string
  hostProof: HostProof
  transportProof: TransportProof
  dns: unknown
}

const fixture = JSON.parse(
  readFileSync(new URL('../mobile/contracts/trust-fixture.json', import.meta.url), 'utf8')
) as NativeFixture

const independentFetch: typeof fetch = async (input) => {
  const url = new URL(String(input))
  if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json(fixture.jwks)
  if (
    url.origin === 'https://cloudflare-dns.com' &&
    url.pathname === '/dns-query' &&
    url.searchParams.get('name') === `_loom.${fixture.domain}` &&
    url.searchParams.get('type') === 'TXT'
  )
    return Response.json(fixture.dns)
  throw new Error('Unexpected independent verification request')
}

describe('shared native trust fixture compatibility', () => {
  const options = { fetch: independentFetch, now: () => fixture.now }
  const signIn = {
    base: fixture.base,
    nonce: fixture.nonce,
    expectedEmail: fixture.expectedEmail,
    idToken: fixture.idToken,
    proof: fixture.hostProof
  }

  it('anchors the native golden identity and host proof using the existing desktop verifier', async () => {
    await expect(verifyHostProof(signIn, options)).resolves.toEqual({
      version: 3,
      domain: fixture.domain
    })
  })

  it('preserves the signed transport bytes containing unescaped slash characters', async () => {
    expect(fixture.transportProof.tls_fingerprint).toContain('/')
    await expect(
      verifyTransportProof(
        fixture.base,
        { version: 3, domain: fixture.domain },
        fixture.transportProof,
        options
      )
    ).resolves.toEqual(fixture.transportProof)
  })

  it('requires the independently entered email and the original sign-in nonce', async () => {
    await expect(
      verifyHostProof({ ...signIn, expectedEmail: 'different@example.com' }, options)
    ).rejects.toThrow()
    await expect(verifyHostProof({ ...signIn, nonce: 'another-attempt' }, options)).rejects.toThrow()
  })

  it('refuses the same signed binding after its expiry and refuses signature tampering', async () => {
    const trust = { version: 3 as const, domain: fixture.domain }
    await expect(
      verifyTransportProof(fixture.base, trust, fixture.transportProof, {
        ...options,
        now: () => fixture.transportProof.expires_at
      })
    ).rejects.toThrow()
    const signature = fixture.transportProof.signature
    await expect(
      verifyTransportProof(
        fixture.base,
        trust,
        {
          ...fixture.transportProof,
          signature: `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`
        },
        options
      )
    ).rejects.toThrow()
  })
})
