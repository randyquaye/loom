import { createPublicKey } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import type { TransportProof } from '../../shared/org'
import { parseTransportProof } from '../auth/transport-proof'

/** Read the root-published TLS binding afresh so renewal and expiry need no runner restart. */
export function createTransportProofReader(
  file: string,
  publicUrl: string,
  signingKey: string,
  now: () => number = Date.now
): () => TransportProof | null {
  const host = new URL(publicUrl).hostname.toLowerCase()
  const expectedKey = createPublicKey(signingKey).export({ type: 'spki', format: 'der' }).toString('base64')
  return () => {
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) return null
      const proof = parseTransportProof(JSON.parse(readFileSync(file, 'utf8')), host, now())
      return proof?.public_key === expectedKey ? proof : null
    } catch {
      return null
    }
  }
}
