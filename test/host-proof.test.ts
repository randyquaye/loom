import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostProofError, verifyHostProof } from '../src/main/cloud/host-proof'

const now = 1_800_000_000
const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
const runner = generateKeyPairSync('ed25519')
const publicKey = runner.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const fingerprint = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64')
const host = 'loom.company-tools.com'
const nonce = 'desktop-nonce'
const expectedEmail = 'ada@company.com'

function token(claims: Record<string, unknown> = {}, key = google.privateKey): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'google-key' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      sub: 'person',
      iat: now,
      exp: now + 600,
      email: 'ada@company.com',
      email_verified: true,
      hd: 'company.com',
      nonce,
      ...claims
    })
  ).toString('base64url')
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key).toString('base64url')}`
}

function proof(signedHost = host, key = runner) {
  return {
    host: signedHost,
    public_key: key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    signature: sign(
      null,
      Buffer.from(JSON.stringify(['loom.host-proof.v1', signedHost, nonce])),
      key.privateKey
    ).toString('base64')
  }
}

function network(record = `loom-host=${host}; key=${fingerprint}`) {
  return vi.fn(async (url: string | URL | Request) => {
    const address = String(url)
    if (address === 'https://www.googleapis.com/oauth2/v3/certs') {
      return Response.json({
        keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: 'google-key', alg: 'RS256' }]
      })
    }
    if (address.startsWith('https://cloudflare-dns.com/dns-query?')) {
      expect(new URL(address).searchParams.get('name')).toBe('_loom.company.com')
      return Response.json({
        Status: 0,
        Answer: [{ name: '_loom.company.com', type: 16, data: JSON.stringify(record) }]
      })
    }
    throw new Error(`Unexpected network destination ${address}`)
  })
}

afterEach(() => vi.restoreAllMocks())

describe('desktop host proof', () => {
  it('returns typed proof refusals for independent network, JSON, and malformed-proof failures', async () => {
    const input = { base: `https://${host}`, nonce, expectedEmail, idToken: token(), proof: proof() }
    const offline = vi.fn(async () => {
      throw new Error('offline')
    })
    const invalidJson = vi.fn(async () => new Response('{'))
    await expect(verifyHostProof(input, { fetch: offline, now: () => now * 1000 })).rejects.toBeInstanceOf(
      HostProofError
    )
    await expect(
      verifyHostProof(input, { fetch: invalidJson, now: () => now * 1000 })
    ).rejects.toBeInstanceOf(HostProofError)
    await expect(
      verifyHostProof(
        { ...input, proof: null as unknown as ReturnType<typeof proof> },
        { fetch: network(), now: () => now * 1000 }
      )
    ).rejects.toBeInstanceOf(HostProofError)
  })

  it('refuses a TXT answer owned by another DNS name', async () => {
    const request = network()
    request.mockImplementationOnce(async () =>
      Response.json({
        keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: 'google-key', alg: 'RS256' }]
      })
    )
    request.mockImplementationOnce(async () =>
      Response.json({
        Status: 0,
        Answer: [
          {
            name: '_loom.attacker.com',
            type: 16,
            data: JSON.stringify(`loom-host=${host}; key=${fingerprint}`)
          }
        ]
      })
    )
    await expect(
      verifyHostProof(
        { base: `https://${host}`, nonce, expectedEmail, idToken: token(), proof: proof() },
        { fetch: request, now: () => now * 1000 }
      )
    ).rejects.toThrow()
  })

  it('refuses a valid Google identity for somebody other than the independently entered email', async () => {
    await expect(
      verifyHostProof(
        {
          base: `https://${host}`,
          nonce,
          expectedEmail: 'victim@victim-company.com',
          idToken: token(),
          proof: proof()
        },
        { fetch: network(), now: () => now * 1000 }
      )
    ).rejects.toThrow()
  })

  it('refuses a missing independent email and accepts case-insensitive primary Google email', async () => {
    await expect(
      verifyHostProof(
        { base: `https://${host}`, nonce, idToken: token(), proof: proof() },
        { fetch: network(), now: () => now * 1000 }
      )
    ).rejects.toThrow()
    await expect(
      verifyHostProof(
        {
          base: `https://${host}`,
          nonce,
          expectedEmail: 'ADA@COMPANY.COM',
          idToken: token(),
          proof: proof()
        },
        { fetch: network(), now: () => now * 1000 }
      )
    ).resolves.toEqual({ version: 3, domain: 'company.com' })
  })

  it('accepts an exact domain record and Google identity bound to this runner and nonce', async () => {
    await expect(
      verifyHostProof(
        { base: `https://${host}`, nonce, expectedEmail, idToken: token(), proof: proof() },
        { fetch: network(), now: () => now * 1000 }
      )
    ).resolves.toEqual({ version: 3, domain: 'company.com' })
  })

  it.each([
    ['another nonce', { nonce: 'another-desktop' }],
    ['expired token', { exp: now - 1 }],
    ['old token', { iat: now - 601 }],
    ['personal account', { hd: undefined }],
    ['unverified email', { email_verified: false }],
    ['foreign issuer', { iss: 'https://attacker.example' }]
  ])('refuses %s', async (_name, claims) => {
    await expect(
      verifyHostProof(
        { base: `https://${host}`, nonce, expectedEmail, idToken: token(claims), proof: proof() },
        { fetch: network(), now: () => now * 1000 }
      )
    ).rejects.toThrow()
  })

  it('refuses an attacker-signed token even with correct claims', async () => {
    const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 })
    await expect(
      verifyHostProof(
        {
          base: `https://${host}`,
          nonce,
          expectedEmail,
          idToken: token({}, attacker.privateKey),
          proof: proof()
        },
        { fetch: network(), now: () => now * 1000 }
      )
    ).rejects.toThrow()
  })

  it.each([
    '',
    `loom-host=${host}.evil.com; key=${fingerprint}`,
    `loom-host=${host}; key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`
  ])('refuses an absent or nonmatching record: %s', async (record) => {
    await expect(
      verifyHostProof(
        { base: `https://${host}`, nonce, expectedEmail, idToken: token(), proof: proof() },
        { fetch: network(record), now: () => now * 1000 }
      )
    ).rejects.toThrow()
  })

  it('refuses a listed host without the recorded signing key', async () => {
    const attacker = generateKeyPairSync('ed25519')
    await expect(
      verifyHostProof(
        { base: `https://${host}`, nonce, expectedEmail, idToken: token(), proof: proof(host, attacker) },
        { fetch: network(), now: () => now * 1000 }
      )
    ).rejects.toThrow()
  })

  it('refuses a real runner signature relayed through a different listed host', async () => {
    const relay = 'relay.company-tools.com'
    await expect(
      verifyHostProof(
        { base: `https://${relay}`, nonce, expectedEmail, idToken: token(), proof: proof() },
        { fetch: network(`loom-host=${relay}; key=${fingerprint}`), now: () => now * 1000 }
      )
    ).rejects.toThrow()
  })

  it('refuses lookup failures without another resolver or runner request', async () => {
    const request = network()
    request.mockImplementationOnce(async () =>
      Response.json({
        keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: 'google-key', alg: 'RS256' }]
      })
    )
    request.mockImplementationOnce(async () => {
      throw new Error('DNS unavailable')
    })
    await expect(
      verifyHostProof(
        { base: `https://${host}`, nonce, expectedEmail, idToken: token(), proof: proof() },
        { fetch: request, now: () => now * 1000 }
      )
    ).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('requires proof on a typed address and on production loopback addresses', async () => {
    await expect(
      verifyHostProof({ base: `https://${host}`, nonce }, { fetch: network(), now: () => now * 1000 })
    ).rejects.toThrow()
    await expect(
      verifyHostProof({ base: 'http://127.0.0.1:3000', nonce }, { fetch: network(), development: false })
    ).rejects.toThrow()
    await expect(
      verifyHostProof({ base: 'http://127.0.0.1:3000', nonce }, { fetch: network(), development: true })
    ).resolves.toBeNull()
  })
})
