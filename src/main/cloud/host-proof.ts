import { createHash, createPublicKey, verify, type JsonWebKeyInput, type KeyObject } from 'node:crypto'
import type { HostProof, RunnerTrust } from '../../shared/org'
import { isLoopbackHost } from '../auth/callback'
import {
  isGoogleClientId,
  isManagedGoogleEmail,
  isManagedRunnerOrigin,
  type CloudSignInMode
} from '../../shared/managed-cloud'

const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs'
const DNS_RESOLVER = 'https://cloudflare-dns.com/dns-query'
const MAX_TOKEN_AGE_SECONDS = 600
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export interface ProofOptions {
  fetch?: typeof fetch
  now?: () => number
  development?: boolean | undefined
}

interface HostSignIn {
  mode?: CloudSignInMode
  base: string
  nonce: string
  expectedEmail?: string
  idToken?: string | undefined
  proof?: HostProof | undefined
}

function refused(reason: string): never {
  throw new HostProofError(`The organization's host could not be verified: ${reason}`)
}

export class HostProofError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostProofError'
  }
}

function object(encoded: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return refused('invalid Google token')
    return value as Record<string, unknown>
  } catch {
    return refused('invalid Google token')
  }
}

/** DNS JSON represents a TXT value as one or more quoted character strings. */
function txtValue(data: string): string | null {
  const chunks = data.match(/"(?:[^"\\]|\\.)*"/g)
  if (chunks === null || data.replace(/"(?:[^"\\]|\\.)*"/g, '').trim() !== '') return null
  try {
    return chunks.map((chunk) => JSON.parse(chunk) as string).join('')
  } catch {
    return null
  }
}

/** Verifies independent Google and domain evidence before any credentials are saved or used. */
export async function verifyHostProof(
  input: HostSignIn,
  options: ProofOptions = {}
): Promise<RunnerTrust | null> {
  try {
    return await checkHostProof(input, options)
  } catch (error) {
    if (error instanceof HostProofError) throw error
    return refused('independent verification failed; sign in again when it is available')
  }
}

async function checkHostProof(input: HostSignIn, options: ProofOptions): Promise<RunnerTrust | null> {
  const address = new URL(input.base)
  const host = address.hostname.toLowerCase()
  if (options.development === true && isLoopbackHost(host)) return null
  if (address.protocol !== 'https:') return refused('a production host must use HTTPS')
  if (input.mode === 'managed' && !isManagedRunnerOrigin(input.base))
    return refused('this is not a Loom-managed runner address')
  const expectedEmail = input.expectedEmail?.trim().toLowerCase()
  if (expectedEmail === undefined || expectedEmail === '')
    return refused('enter your Google email before signing in')
  const { idToken, proof } = input
  if (idToken === undefined || proof === undefined || idToken.length > 32768) {
    return refused('the runner did not return its sign-in proof; update it and sign in again')
  }
  const segments = idToken.split('.')
  if (segments.length !== 3 || segments.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    return refused('invalid Google token')
  }
  const header = object(segments[0]!)
  const claims = object(segments[1]!)
  if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string')
    return refused('invalid Google signing key')

  const request = options.fetch ?? fetch
  async function json(url: string, accept: string): Promise<Record<string, unknown>> {
    const response = await request(url, {
      headers: { Accept: accept },
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    })
    if (!response.ok) return refused('independent verification service is unavailable')
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object') return refused('invalid verification reply')
    return body as Record<string, unknown>
  }

  const keys = await json(GOOGLE_KEYS, 'application/json')
  const key = Array.isArray(keys['keys'])
    ? (keys['keys'] as Array<Record<string, unknown>>).find(
        (item) => item['kid'] === header['kid'] && item['kty'] === 'RSA' && item['alg'] === 'RS256'
      )
    : undefined
  if (key === undefined) return refused('Google did not publish this signing key')
  let authentic = false
  try {
    authentic = verify(
      'RSA-SHA256',
      Buffer.from(`${segments[0]}.${segments[1]}`),
      createPublicKey({ key: key as JsonWebKeyInput['key'], format: 'jwk' }),
      Buffer.from(segments[2]!, 'base64url')
    )
  } catch {
    return refused('invalid Google signature')
  }
  if (!authentic) return refused('invalid Google signature')
  const now = Math.floor((options.now ?? Date.now)() / 1000)
  if (
    (claims['iss'] !== 'https://accounts.google.com' && claims['iss'] !== 'accounts.google.com') ||
    typeof claims['exp'] !== 'number' ||
    !Number.isFinite(claims['exp']) ||
    claims['exp'] <= now ||
    typeof claims['iat'] !== 'number' ||
    !Number.isFinite(claims['iat']) ||
    claims['iat'] > now + 60 ||
    now - claims['iat'] > MAX_TOKEN_AGE_SECONDS ||
    claims['nonce'] !== input.nonce ||
    input.nonce === '' ||
    (claims['email_verified'] !== true && claims['email_verified'] !== 'true') ||
    typeof claims['email'] !== 'string' ||
    claims['email'].toLowerCase() !== expectedEmail ||
    typeof claims['sub'] !== 'string' ||
    claims['sub'] === ''
  )
    return refused('Google identity is missing, expired, or belongs to another sign-in')
  const domain = typeof claims['hd'] === 'string' ? claims['hd'].toLowerCase() : ''
  const managed = input.mode === 'managed'
  if (managed) {
    if (!isGoogleClientId(claims['aud']) || !isManagedGoogleEmail(expectedEmail, domain || null))
      return refused('a verified Gmail or Google Workspace account is required')
  } else if (!DOMAIN.test(domain)) return refused('a verified Google Workspace account is required')
  if (proof.host !== host || typeof proof.public_key !== 'string' || typeof proof.signature !== 'string') {
    return refused('the runner proof names another host')
  }
  const publicKey = await verifyDomainHostKey(managed ? host : domain, host, proof.public_key, {
    ...options,
    ...(managed ? { googleClientId: claims['aud'] as string } : {})
  })
  const payload = Buffer.from(JSON.stringify(['loom.host-proof.v1', host, input.nonce]))
  if (!verify(null, payload, publicKey, Buffer.from(proof.signature, 'base64'))) {
    return refused('the runner could not prove it holds the listed signing key')
  }
  return managed ? { version: 4, host, googleClientId: claims['aud'] as string } : { version: 3, domain }
}

/** Both fresh sign-in and reconnects use the same independent domain authorization. */
export async function verifyDomainHostKey(
  domain: string,
  host: string,
  encodedKey: string,
  options: Pick<ProofOptions, 'fetch'> & { googleClientId?: string } = {}
): Promise<KeyObject> {
  if (!DOMAIN.test(domain) || encodedKey.length > 512)
    return refused('invalid Workspace domain or runner key')
  const der = Buffer.from(encodedKey, 'base64')
  const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' })
  if (publicKey.asymmetricKeyType !== 'ed25519') return refused('the runner key is not Ed25519')
  const fingerprint = createHash('sha256').update(der).digest('base64')
  const query = new URLSearchParams({ name: `_loom.${domain}`, type: 'TXT' })
  const response = await (options.fetch ?? fetch)(`${DNS_RESOLVER}?${query}`, {
    headers: { Accept: 'application/dns-json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  })
  if (!response.ok) return refused('the independent DNS lookup failed')
  const dns = (await response.json()) as Record<string, unknown>
  const listed =
    dns['Status'] === 0 &&
    Array.isArray(dns['Answer']) &&
    dns['Answer'].some((answer: Record<string, unknown>) => {
      if (
        answer['type'] !== 16 ||
        typeof answer['data'] !== 'string' ||
        typeof answer['name'] !== 'string' ||
        answer['name'].toLowerCase().replace(/\.$/, '') !== `_loom.${domain}`
      )
        return false
      const record = txtValue(answer['data'])?.trim()
      const match = record?.match(
        /^loom-host=([^;\s]+);\s*key=([A-Za-z0-9+/]{43}=)(?:;\s*google-client=([A-Za-z0-9-]+\.apps\.googleusercontent\.com))?$/
      )
      return (
        match !== null &&
        match !== undefined &&
        match[1]?.toLowerCase() === host &&
        match[2] === fingerprint &&
        match[3] === options.googleClientId
      )
    })
  if (!listed) return refused(`_loom.${domain} does not list this host and signing key`)
  return publicKey
}
