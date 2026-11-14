import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { verifyTransportProof, readRunnerTrust, createRunnerTransport } from '../src/main/cloud/transport'
import { transportProofPayload, type TransportProof } from '../src/shared/org'

const key = generateKeyPairSync('ed25519')
const publicKey = key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const fingerprint = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64')
const now = 1_800_000_000_000
const host = 'loom.company-tools.com'
const domain = 'company.com'

function proof(changes: Partial<TransportProof> = {}): TransportProof {
  const input = {
    host,
    public_key: publicKey,
    tls_fingerprint: createHash('sha256').update('TLS fixture').digest('base64'),
    issued_at: now - 1000,
    expires_at: now + 60000,
    signature: '',
    ...changes
  }
  return {
    ...input,
    signature: sign(null, Buffer.from(transportProofPayload(input)), key.privateKey).toString('base64')
  }
}

function dns(recordHost = host) {
  return vi.fn(async (url: string | URL | Request) => {
    const query = new URL(String(url))
    expect(query.origin).toBe('https://cloudflare-dns.com')
    expect(query.searchParams.get('name')).toBe(`_loom.${domain}`)
    return Response.json({
      Status: 0,
      Answer: [
        {
          name: `_loom.${domain}`,
          type: 16,
          data: JSON.stringify(`loom-host=${recordHost}; key=${fingerprint}`)
        }
      ]
    })
  })
}

describe('runner transport authorization', () => {
  it('accepts a current signed TLS-key binding under the previously verified Workspace domain', async () => {
    await expect(
      verifyTransportProof(`https://${host}`, { version: 3, domain }, proof(), {
        fetch: dns(),
        now: () => now
      })
    ).resolves.toEqual(proof())
  })

  it.each([
    ['another hostname', { host: 'relay.company-tools.com' }],
    ['expired binding', { expires_at: now }],
    ['future binding', { issued_at: now + 61000, expires_at: now + 120000 }],
    ['overlong interval', { expires_at: now + 900001 }],
    ['non-SHA256 TLS key', { tls_fingerprint: 'not-a-fingerprint' }]
  ])('refuses %s', async (_name, changes) => {
    await expect(
      verifyTransportProof(`https://${host}`, { version: 3, domain }, proof(changes), {
        fetch: dns(),
        now: () => now
      })
    ).rejects.toThrow()
  })

  it('refuses a changed pin without the organization signature, and an unlisted host', async () => {
    await expect(
      verifyTransportProof(
        `https://${host}`,
        { version: 3, domain },
        { ...proof(), tls_fingerprint: 'b'.repeat(43) + '=' },
        { fetch: dns(), now: () => now }
      )
    ).rejects.toThrow()
    await expect(
      verifyTransportProof(`https://${host}`, { version: 3, domain }, proof(), {
        fetch: dns(`${host}.evil.com`),
        now: () => now
      })
    ).rejects.toThrow()
  })

  it('treats old, malformed, or untrusted cached markers as requiring fresh sign-in', async () => {
    for (const marker of [null, '1', '2', '{', '{"version":3,"domain":"evil.com/path"}', '{"version":3}'])
      expect(readRunnerTrust(marker)).toBeNull()
    expect(readRunnerTrust(JSON.stringify({ version: 3, domain }))).toEqual({ version: 3, domain })
    const fetch = vi.fn()
    const transport = createRunnerTransport({ base: `https://${host}`, trust: async () => null, fetch })
    await expect(transport.post('/auth/token', { refresh_token: 'never-send' })).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    transport.close()
  })
})
