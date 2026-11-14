import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { TRANSPORT_PROOF_TTL_MS, transportProofPayload, type TransportProof } from '../../shared/org'

function base64(value: unknown, bytes?: number): Buffer | null {
  if (typeof value !== 'string' || value.length > 1024) return null
  const decoded = Buffer.from(value, 'base64')
  return decoded.toString('base64') === value && (bytes === undefined || decoded.length === bytes)
    ? decoded
    : null
}

function interval(issuedAt: number, expiresAt: number): boolean {
  return (
    Number.isSafeInteger(issuedAt) &&
    Number.isSafeInteger(expiresAt) &&
    issuedAt > 0 &&
    expiresAt > issuedAt &&
    expiresAt - issuedAt <= TRANSPORT_PROOF_TTL_MS
  )
}

/** Authorizes the locally observed TLS leaf key with the org's durable signing key. */
export function createTransportProof(
  privateKeyPem: string,
  host: string,
  tlsFingerprint: string,
  issuedAt: number,
  expiresAt: number
): TransportProof {
  const address = new URL(`https://${host}`)
  if (
    address.host !== host.toLowerCase() ||
    address.port !== '' ||
    address.pathname !== '/' ||
    address.search ||
    address.hash ||
    base64(tlsFingerprint, 32) === null ||
    !interval(issuedAt, expiresAt)
  )
    throw new Error('Invalid transport authorization host, fingerprint or expiration')
  const key = createPrivateKey(privateKeyPem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The runner signing key must be Ed25519')
  const fields = {
    host: address.hostname,
    tls_fingerprint: tlsFingerprint,
    issued_at: issuedAt,
    expires_at: expiresAt
  }
  return {
    ...fields,
    public_key: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64'),
    signature: sign(null, Buffer.from(transportProofPayload(fields)), key).toString('base64')
  }
}

/** Checks syntax, freshness and self-signature. The caller must independently anchor the org key. */
export function parseTransportProof(input: unknown, host: string, now = Date.now()): TransportProof | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  const issued = value['issued_at']
  const expires = value['expires_at']
  if (
    value['host'] !== host ||
    typeof issued !== 'number' ||
    typeof expires !== 'number' ||
    !interval(issued, expires) ||
    issued > now + 60_000 ||
    expires <= now
  )
    return null
  const fingerprint = base64(value['tls_fingerprint'], 32)
  const publicKey = base64(value['public_key'])
  const signature = base64(value['signature'], 64)
  if (fingerprint === null || publicKey === null || signature === null) return null
  const proof: TransportProof = {
    host,
    tls_fingerprint: fingerprint.toString('base64'),
    issued_at: issued,
    expires_at: expires,
    public_key: publicKey.toString('base64'),
    signature: signature.toString('base64')
  }
  try {
    const key = createPublicKey({ key: publicKey, type: 'spki', format: 'der' })
    if (key.asymmetricKeyType !== 'ed25519' || !key.export({ type: 'spki', format: 'der' }).equals(publicKey))
      return null
    return verify(null, Buffer.from(transportProofPayload(proof)), key, signature) ? proof : null
  } catch {
    return null
  }
}
