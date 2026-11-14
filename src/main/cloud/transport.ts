import { createHash, X509Certificate } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import { checkServerIdentity, type ConnectionOptions } from 'node:tls'
import type { RunnerTrust, TransportProof } from '../../shared/org'
import { isLoopbackHost } from '../auth/callback'
import { HostProofError, verifyDomainHostKey } from './host-proof'
import { parseTransportProof } from '../auth/transport-proof'

const MAX_RESPONSE_BYTES = 64 * 1024
const TIMEOUT_MS = 15000
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A connection cannot be proved yet; existing sign-in tokens remain valid for a retry. */
export class TransportProofError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransportProofError'
  }
}

interface VerificationOptions {
  fetch?: typeof fetch
  now?: () => number
}

export interface RunnerTransport {
  post(path: string, fields: Record<string, string>, signal?: AbortSignal): Promise<Response>
  /** A fresh agent, owned and destroyed by the WebSocket that uses it. */
  websocketAgent(): Promise<Agent | undefined>
  close(): void
}

interface TransportOptions extends VerificationOptions {
  base: string
  trust(): Promise<RunnerTrust | null>
  development?: boolean
  /** Internal dependency for local TLS fixtures; never exposed through settings or environment. */
  ca?: ConnectionOptions['ca']
}

export function readRunnerTrust(value: string | null): RunnerTrust | null {
  try {
    const trust = JSON.parse(value ?? 'null') as RunnerTrust | null
    return trust?.version === 3 && typeof trust.domain === 'string' && DOMAIN.test(trust.domain)
      ? { version: 3, domain: trust.domain }
      : null
  } catch {
    return null
  }
}

/** The saved Google domain authorizes the org key; that key authorizes one current TLS key. */
export async function verifyTransportProof(
  base: string,
  trust: RunnerTrust,
  value: unknown,
  options: VerificationOptions = {}
): Promise<TransportProof> {
  try {
    const host = new URL(base).hostname.toLowerCase()
    const proof = parseTransportProof(value, host, (options.now ?? Date.now)())
    if (proof === null || trust.version !== 3 || !DOMAIN.test(trust.domain)) throw new Error()
    await verifyDomainHostKey(trust.domain, host, proof.public_key, options)
    return proof
  } catch (error) {
    if (error instanceof TransportProofError) throw error
    throw new TransportProofError('The cloud host could not prove its current TLS connection')
  }
}

export async function readRunnerJson(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null)
    throw new HostProofError('The runner transport proof is unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new HostProofError('The runner transport proof is too large')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (error) {
    if (error instanceof HostProofError) throw error
    throw new HostProofError('The runner returned an invalid sign-in proof')
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Credential requests use normal TLS validation plus the independently authorized leaf SPKI. */
export function createRunnerTransport(options: TransportOptions): RunnerTransport {
  const address = new URL(options.base)
  const host = address.hostname.toLowerCase()
  const development = options.development === true && isLoopbackHost(host)
  if (
    address.username ||
    address.password ||
    address.pathname !== '/' ||
    address.search ||
    address.hash ||
    (!development && address.protocol !== 'https:')
  ) {
    throw new TransportProofError('A runner transport requires a secure host address')
  }
  const lifetime = new AbortController()
  const request = options.fetch ?? fetch
  const independentFetch: typeof fetch = (input, init) =>
    request(input, {
      ...init,
      signal: AbortSignal.any([lifetime.signal, init?.signal ?? AbortSignal.timeout(TIMEOUT_MS)])
    })

  async function verifiedAgent(): Promise<Agent | undefined> {
    lifetime.signal.throwIfAborted()
    if (development) return undefined
    const trust = await options.trust()
    if (trust === null) throw new TransportProofError('Sign in again to verify this organization’s host')
    const response = await independentFetch(`${address.origin}/auth/transport`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const proof = await verifyTransportProof(address.origin, trust, await readRunnerJson(response), {
      fetch: independentFetch,
      ...(options.now === undefined ? {} : { now: options.now })
    })
    lifetime.signal.throwIfAborted()
    return new Agent({
      keepAlive: false,
      maxCachedSessions: 0,
      rejectUnauthorized: true,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
      checkServerIdentity(name, certificate) {
        const ordinary = checkServerIdentity(name, certificate)
        if (ordinary !== undefined) return ordinary
        if (
          lifetime.signal.aborted ||
          name.toLowerCase() !== host ||
          (options.now ?? Date.now)() >= proof.expires_at
        )
          return new TransportProofError('The runner TLS proof is no longer current')
        try {
          const spki = new X509Certificate(certificate.raw).publicKey.export({ type: 'spki', format: 'der' })
          const fingerprint = createHash('sha256').update(spki).digest('base64')
          if (fingerprint !== proof.tls_fingerprint)
            return new TransportProofError('The TLS connection does not belong to the authorized runner')
          return undefined
        } catch {
          return new TransportProofError('The runner TLS certificate could not be verified')
        }
      }
    })
  }

  async function agent(): Promise<Agent | undefined> {
    try {
      return await verifiedAgent()
    } catch (error) {
      if (error instanceof TransportProofError) throw error
      throw new TransportProofError('The cloud host transport proof is unavailable')
    }
  }

  return {
    websocketAgent: agent,
    async post(path, fields, signal) {
      const target = new URL(path, address)
      if (!path.startsWith('/') || target.origin !== address.origin)
        throw new TransportProofError('A credential request cannot leave its runner')
      const pinned = await agent()
      try {
        lifetime.signal.throwIfAborted()
        const body = new URLSearchParams(fields).toString()
        return await new Promise<Response>((resolve, reject) => {
          const send = target.protocol === 'https:' ? httpsRequest : httpRequest
          const call = send(
            target,
            {
              method: 'POST',
              agent: pinned,
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
              },
              signal: AbortSignal.any([
                lifetime.signal,
                signal ?? AbortSignal.timeout(TIMEOUT_MS),
                AbortSignal.timeout(TIMEOUT_MS)
              ])
            },
            (reply) => {
              const chunks: Buffer[] = []
              let size = 0
              reply.on('data', (chunk: Buffer) => {
                size += chunk.length
                if (size > MAX_RESPONSE_BYTES)
                  return reply.destroy(new Error('The runner reply is too large'))
                chunks.push(chunk)
              })
              reply.once('error', reject)
              reply.once('end', () =>
                resolve(
                  new Response(chunks.length === 0 ? null : Buffer.concat(chunks), {
                    status: reply.statusCode ?? 502
                  })
                )
              )
            }
          )
          call.once('error', reject)
          call.end(body)
        })
      } finally {
        pinned?.destroy()
      }
    },
    close() {
      lifetime.abort(new Error('The runner transport closed'))
    }
  }
}
