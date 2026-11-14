import { createHash, createPublicKey, generateKeyPairSync, verify, X509Certificate } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type * as Fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { connect, type ConnectionOptions } from 'node:tls'
import type * as Tls from 'node:tls'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransportProof, parseTransportProof } from '../src/main/auth/transport-proof'
import { probeCaddyCertificate, publishTransportProof } from '../src/main/runner/transport-proof'
import { TRANSPORT_PROOF_TTL_MS, transportProofPayload } from '../src/shared/org'

vi.mock('node:tls', async (original) => ({ ...(await original<typeof Tls>()), connect: vi.fn() }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof Fs>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

// Public EC certificate only. Its legacy pubkey encoding is deliberately not used.
const certificate = new X509Certificate(`-----BEGIN CERTIFICATE-----
MIIBpzCCAU2gAwIBAgITb6GrBTIHTcoGfHQlyMMwVBGV+DAKBggqhkjOPQQDAjAb
MRkwFwYDVQQDDBBsb29tLmNvbXBhbnkuY29tMB4XDTI2MTExNDExMDQxOFoXDTI3
MTExNDExMDQxOFowGzEZMBcGA1UEAwwQbG9vbS5jb21wYW55LmNvbTBZMBMGByqG
SM49AgEGCCqGSM49AwEHA0IABN7YpB8ds0OuCrm1IO90caHe7QwBwVp7RUrAw9/r
dRwbCP/eWm79pwa5Qss9Bv2BEEEVhSayPPQSdgy3HH3rr8CjcDBuMB0GA1UdDgQW
BBSpjXFRNCkFQW7swZ8izr9qhpcAHjAfBgNVHSMEGDAWgBSpjXFRNCkFQW7swZ8i
zr9qhpcAHjAPBgNVHRMBAf8EBTADAQH/MBsGA1UdEQQUMBKCEGxvb20uY29tcGFu
eS5jb20wCgYIKoZIzj0EAwIDSAAwRQIgLokWE7t5F+eQP8p2rSLOJSpvPqBgkgZX
5A8nnhYrtqECIQDZ7Dk69p6oN4pxYIixl8zCVoDWAC5GgAJ5celRErqBmw==
-----END CERTIFICATE-----`)
const host = 'loom.company.com'
const key = generateKeyPairSync('ed25519')
const privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const certificateEnd = Date.parse(certificate.validTo)
const now = certificateEnd - 60 * 60_000
const fingerprint = createHash('sha256')
  .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64')
const roots: string[] = []

function connection(error?: Error) {
  const socket = Object.assign(new EventEmitter(), {
    authorized: true,
    authorizationError: null,
    getPeerCertificate: () => ({ raw: certificate.raw, pubkey: Buffer.from('not SPKI') }),
    destroy: vi.fn((reason?: Error) => {
      if (reason !== undefined) queueMicrotask(() => socket.emit('error', reason))
      return socket
    })
  })
  vi.mocked(connect).mockImplementation(() => {
    queueMicrotask(() => socket.emit(error === undefined ? 'secureConnect' : 'error', error))
    return socket as unknown as ReturnType<typeof connect>
  })
  return socket
}

async function files() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-transport-'))
  roots.push(root)
  const keyFile = path.join(root, 'runner.pem')
  const outputFile = path.join(root, 'proof.json')
  await writeFile(keyFile, privateKey)
  await writeFile(outputFile, 'previous proof')
  return { root, keyFile, outputFile, host }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('transport authorization publisher', () => {
  it('uses only loopback with normal CA and configured-host verification', async () => {
    const socket = connection()
    const peer = await probeCaddyCertificate(host)
    expect(peer.raw.equals(certificate.raw)).toBe(true)
    const options = vi.mocked(connect).mock.calls[0]![0] as unknown as ConnectionOptions
    expect(options).toMatchObject({
      host: '127.0.0.1',
      port: 443,
      servername: host,
      rejectUnauthorized: true
    })
    expect(options.checkServerIdentity?.('untrusted-input', certificate.toLegacyObject())).toBeUndefined()
    expect(socket.destroy).toHaveBeenCalled()
  })

  it('does not weaken hostname verification for another configured host', async () => {
    connection()
    await probeCaddyCertificate('other.company.com')
    const options = vi.mocked(connect).mock.calls[0]![0] as unknown as ConnectionOptions
    expect(options.checkServerIdentity?.('loom.company.com', certificate.toLegacyObject())).toBeInstanceOf(
      Error
    )
  })

  it('bounds an unresponsive TLS probe to five seconds', async () => {
    vi.useFakeTimers()
    const socket = connection()
    vi.mocked(connect).mockImplementationOnce(() => socket as unknown as ReturnType<typeof connect>)
    const pending = probeCaddyCertificate(host)
    const refused = expect(pending).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(5000)
    expect(socket.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Local TLS certificate probe timed out' })
    )
    await refused
  })

  it('publishes public SPKI authorization with bounded expiry and public file permissions', async () => {
    connection()
    const input = await files()
    const proof = await publishTransportProof(input, () => now)
    expect(proof.tls_fingerprint).toBe(fingerprint)
    expect(proof.issued_at).toBe(now)
    expect(proof.expires_at).toBe(now + TRANSPORT_PROOF_TTL_MS)
    expect(JSON.parse(await readFile(input.outputFile, 'utf8'))).toEqual(proof)
    expect((await stat(input.outputFile)).mode & 0o777).toBe(0o644)
    expect((await readdir(input.root)).sort()).toEqual(['proof.json', 'runner.pem'])
    expect(
      verify(
        null,
        Buffer.from(transportProofPayload(proof)),
        createPublicKey(key.privateKey),
        Buffer.from(proof.signature, 'base64')
      )
    ).toBe(true)
  })

  it('never authorizes beyond the observed certificate expiration', async () => {
    connection()
    const proof = await publishTransportProof(await files(), () => certificateEnd - 30_000)
    expect(proof.expires_at).toBe(certificateEnd)
  })

  it('retains previous metadata when certificate validation fails', async () => {
    connection(new Error('self-signed certificate'))
    const input = await files()
    await expect(publishTransportProof(input, () => now)).rejects.toThrow('self-signed certificate')
    expect(await readFile(input.outputFile, 'utf8')).toBe('previous proof')
  })

  it('retains previous metadata and removes staging after a failed atomic replacement', async () => {
    connection()
    const input = await files()
    vi.mocked(rename).mockRejectedValueOnce(new Error('replacement failed'))
    await expect(publishTransportProof(input, () => now)).rejects.toThrow('replacement failed')
    expect(await readFile(input.outputFile, 'utf8')).toBe('previous proof')
    expect((await readdir(input.root)).sort()).toEqual(['proof.json', 'runner.pem'])
  })

  it('refuses an already expired certificate without replacing prior metadata', async () => {
    connection()
    const input = await files()
    await expect(publishTransportProof(input, () => certificateEnd)).rejects.toThrow(/expir/i)
    expect(await readFile(input.outputFile, 'utf8')).toBe('previous proof')
  })

  it('parses only authentic, current, host-specific manifests without asserting a DNS anchor', () => {
    const proof = createTransportProof(privateKey, host, fingerprint, now, now + 60_000)
    expect(parseTransportProof(proof, host, now)).toEqual(proof)
    for (const invalid of [
      null,
      [],
      { ...proof, host: 'other.company.com' },
      { ...proof, signature: Buffer.alloc(64).toString('base64') },
      { ...proof, tls_fingerprint: Buffer.alloc(31).toString('base64') },
      {
        ...proof,
        public_key: generateKeyPairSync('rsa', { modulusLength: 1024 })
          .publicKey.export({ type: 'spki', format: 'der' })
          .toString('base64')
      }
    ])
      expect(parseTransportProof(invalid, host, now)).toBeNull()
    expect(parseTransportProof(proof, host, proof.expires_at)).toBeNull()
    const future = createTransportProof(privateKey, host, fingerprint, now + 60_001, now + 120_001)
    expect(parseTransportProof(future, host, now)).toBeNull()
  })

  it('signs every authorization field and refuses overlong lifetimes', () => {
    const proof = createTransportProof(privateKey, host, fingerprint, now, now + 60_000)
    for (const field of [
      { host: 'other.company.com' },
      { tls_fingerprint: 'other' },
      { issued_at: now + 1 },
      { expires_at: now + 60_001 }
    ]) {
      expect(
        verify(
          null,
          Buffer.from(transportProofPayload({ ...proof, ...field })),
          key.publicKey,
          Buffer.from(proof.signature, 'base64')
        )
      ).toBe(false)
    }
    expect(() =>
      createTransportProof(privateKey, host, fingerprint, now, now + TRANSPORT_PROOF_TTL_MS + 1)
    ).toThrow()
  })
})
