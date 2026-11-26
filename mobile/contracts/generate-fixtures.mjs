import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { writeFileSync } from 'node:fs'

// Synthetic identities and ephemeral keys only. No private key is written to disk.
const now = 1_800_000_000_000
const host = 'loom.example.com'
const domain = 'example.com'
const expectedEmail = 'developer@example.com'
const nonce = 'native-mobile-test-nonce-0123456789abcdef0123'
const ed25519 = generateKeyPairSync('ed25519')
const publicKey = ed25519.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'loom-fixture-rsa', alg: 'RS256', use: 'sig' }
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwtPayload = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({
  iss: 'https://accounts.google.com',
  aud: 'synthetic-loom-client',
  sub: 'synthetic-developer',
  email: expectedEmail,
  email_verified: true,
  hd: domain,
  nonce,
  iat: Math.floor(now / 1000) - 10,
  exp: Math.floor(now / 1000) + 300
})}`
const idToken = `${jwtPayload}.${sign('RSA-SHA256', Buffer.from(jwtPayload), rsa.privateKey).toString('base64url')}`
const signed = (payload) =>
  sign(null, Buffer.from(JSON.stringify(payload)), ed25519.privateKey).toString('base64')
const hostProof = {
  host,
  public_key: publicKey,
  signature: signed(['loom.host-proof.v1', host, nonce])
}
// '/' deliberately catches native JSON encoders that escape slashes in signed text.
const tlsFingerprint = Buffer.alloc(32, 255).toString('base64')
const issuedAt = now - 1000
const expiresAt = now + 60_000
const transportProof = {
  host,
  public_key: publicKey,
  tls_fingerprint: tlsFingerprint,
  issued_at: issuedAt,
  expires_at: expiresAt,
  signature: signed(['loom.transport-proof.v1', host, tlsFingerprint, issuedAt, expiresAt])
}
const fixture = {
  description: 'Synthetic fixture; no real account, host, TLS key or reusable credential.',
  now,
  host,
  base: `https://${host}`,
  domain,
  expectedEmail,
  nonce,
  jwks: { keys: [jwk] },
  idToken,
  hostProof,
  transportProof,
  dns: {
    Status: 0,
    Answer: [
      {
        name: `_loom.${domain}.`,
        type: 16,
        data: JSON.stringify(
          `loom-host=${host}; key=${createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('base64')}`
        )
      }
    ]
  }
}
writeFileSync(new URL('trust-fixture.json', import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`)
