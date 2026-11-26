import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { verifyHostProof } from '../src/main/cloud/host-proof'
import { readRunnerTrust, verifyTransportProof } from '../src/main/cloud/transport'
import { createHostProof } from '../src/main/auth/host-proof'
import { transportProofPayload } from '../src/shared/org'

const now = 1_800_000_000_000
const host = 'pilot.loombox.xyz'
const clientId = '123-managed.apps.googleusercontent.com'
const nonce = 'desktop-nonce'
const email = 'owner@gmail.com'
const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
const runner = generateKeyPairSync('ed25519')
const key = runner.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const publicKey = runner.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const fingerprint = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64')
const trust = { version: 4 as const, host, googleClientId: clientId }

function token(changes: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'google' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      sub: 'google-owner',
      aud: clientId,
      email,
      email_verified: true,
      iat: now / 1000,
      exp: now / 1000 + 600,
      nonce,
      ...changes
    })
  ).toString('base64url')
  return `${header}.${payload}.${sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), google.privateKey).toString('base64url')}`
}

function network(record = `loom-host=${host}; key=${fingerprint}; google-client=${clientId}`) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.origin === 'https://www.googleapis.com') {
      return Response.json({
        keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: 'google', alg: 'RS256' }]
      })
    }
    expect(url.origin).toBe('https://cloudflare-dns.com')
    expect(url.searchParams.get('name')).toBe(`_loom.${host}`)
    return Response.json({
      Status: 0,
      Answer: [{ name: `_loom.${host}`, type: 16, data: JSON.stringify(record) }]
    })
  })
}

function input(changes: Record<string, unknown> = {}) {
  return {
    mode: 'managed' as const,
    base: `https://${host}`,
    nonce,
    expectedEmail: email,
    idToken: token(changes),
    proof: createHostProof(key, `https://${host}`, nonce)
  }
}

describe('managed runner identity', () => {
  it('accepts Gmail only when Loom authorises both the exact runner key and Google client', async () => {
    await expect(verifyHostProof(input(), { fetch: network(), now: () => now })).resolves.toEqual(trust)
  })

  it.each([
    { aud: 'another.apps.googleusercontent.com' },
    { nonce: 'another-desktop' },
    { email: 'someone@gmail.com' },
    { email_verified: false },
    { email: 'owner@unmanaged.example' }
  ])('refuses another client, person, or unverifiable identity: %j', async (changes) => {
    await expect(verifyHostProof(input(changes), { fetch: network(), now: () => now })).rejects.toThrow()
  })

  it.each([
    `loom-host=${host}; key=${fingerprint}`,
    `loom-host=${host}.evil.com; key=${fingerprint}; google-client=${clientId}`,
    `loom-host=${host}; key=${Buffer.alloc(32, 1).toString('base64')}; google-client=${clientId}`
  ])('refuses unapproved server or missing client authorisation: %s', async (record) => {
    await expect(verifyHostProof(input(), { fetch: network(record), now: () => now })).rejects.toThrow()
  })

  it('cannot apply managed trust to an arbitrary host or a suffix lookalike', async () => {
    for (const candidate of [
      'runner.example.com',
      `${host}.evil.com`,
      'loombox.xyz',
      'evil.pilot.loombox.xyz'
    ]) {
      const fetch = network()
      await expect(
        verifyHostProof({ ...input(), base: `https://${candidate}` }, { fetch, now: () => now })
      ).rejects.toThrow()
    }
  })

  it('keeps managed and saved company trust separate and refuses forged managed hosts', () => {
    expect(readRunnerTrust(JSON.stringify(trust))).toEqual(trust)
    expect(readRunnerTrust(JSON.stringify({ version: 3, domain: 'company.com' }))).toEqual({
      version: 3,
      domain: 'company.com'
    })
    expect(readRunnerTrust(JSON.stringify({ ...trust, host: 'evil.example' }))).toBeNull()
    expect(readRunnerTrust(JSON.stringify({ ...trust, googleClientId: '' }))).toBeNull()
  })

  it('rechecks the managed host and key before authorising a credential connection', async () => {
    const fields = {
      host,
      public_key: publicKey,
      tls_fingerprint: Buffer.alloc(32, 7).toString('base64'),
      issued_at: now,
      expires_at: now + 60_000
    }
    const proof = {
      ...fields,
      signature: sign(null, Buffer.from(transportProofPayload(fields)), runner.privateKey).toString('base64')
    }
    await expect(
      verifyTransportProof(`https://${host}`, trust, proof, { fetch: network(), now: () => now })
    ).resolves.toEqual(proof)
    await expect(
      verifyTransportProof(`https://o-other.loombox.xyz`, trust, proof, { fetch: network(), now: () => now })
    ).rejects.toThrow()
    await expect(
      verifyTransportProof(`https://${host}`, trust, proof, { fetch: network(''), now: () => now })
    ).rejects.toThrow()
  })
})
