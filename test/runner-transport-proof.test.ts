import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { transportProofPayload, type TransportProof } from '../src/shared/org'
import { createTransportProofReader } from '../src/main/runner/transport'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const keys = generateKeyPairSync('ed25519')
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const now = Date.now()
function proof(changes: Partial<TransportProof> = {}, key = keys): TransportProof {
  const fields = {
    host: 'loom.example.com',
    public_key: key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    tls_fingerprint: Buffer.alloc(32, 7).toString('base64'),
    issued_at: now,
    expires_at: now + 60_000,
    ...changes
  }
  return {
    ...fields,
    signature: sign(null, Buffer.from(transportProofPayload(fields)), key.privateKey).toString('base64')
  }
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-transport-reader-'))
  roots.push(root)
  const file = path.join(root, 'proof.json')
  let clock = now
  const read = createTransportProofReader(file, 'https://loom.example.com', privateKey, () => clock)
  return {
    file,
    read,
    time: (value: number) => {
      clock = value
    }
  }
}

describe('runner published transport evidence', () => {
  it('requires a current proof and observes replacement TLS keys without restarting', async () => {
    const f = await fixture()
    expect(f.read()).toBeNull()
    const first = proof()
    await writeFile(f.file, JSON.stringify(first))
    expect(f.read()).toEqual(first)
    const second = proof({ tls_fingerprint: Buffer.alloc(32, 8).toString('base64') })
    await writeFile(`${f.file}.next`, JSON.stringify(second))
    await rename(`${f.file}.next`, f.file)
    expect(f.read()).toEqual(second)
    f.time(now + 60_000)
    expect(f.read()).toBeNull()
  })

  it('never serves another host or an independently signed substitute key as its own', async () => {
    const f = await fixture()
    for (const candidate of [
      proof({ host: 'other.example.com' }),
      proof({}, generateKeyPairSync('ed25519'))
    ]) {
      await writeFile(f.file, JSON.stringify(candidate))
      expect(f.read()).toBeNull()
    }
  })

  it('fails closed during malformed or oversized publication without exposing file content', async () => {
    const f = await fixture()
    for (const data of [
      '{',
      JSON.stringify(null),
      JSON.stringify({ ...proof(), signature: 'invalid' }),
      'x'.repeat(32_768)
    ]) {
      await writeFile(f.file, data)
      expect(f.read()).toBeNull()
    }
  })
})
