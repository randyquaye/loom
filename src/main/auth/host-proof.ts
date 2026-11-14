import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import type { HostProof } from '../../shared/org'

/** Binds the runner's durable signing key to this desktop's fresh nonce and host. */
export function createHostProof(privateKeyPem: string, publicUrl: string, nonce: string): HostProof {
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The runner signing key must be Ed25519')
  const host = new URL(publicUrl).hostname.toLowerCase()
  return {
    host,
    public_key: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'),
    signature: sign(null, Buffer.from(JSON.stringify(['loom.host-proof.v1', host, nonce])), key).toString(
      'base64'
    )
  }
}
