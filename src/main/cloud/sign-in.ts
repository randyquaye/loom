import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { challengeOf, newVerifier } from '../auth/pkce'
import type { HostProof, RunnerTrust } from '../../shared/org'
import { verifyHostProof } from './host-proof'
import { createRunnerTransport, readRunnerJson, type RunnerTransport } from './transport'
import { HostProofError } from './host-proof'
import { isLoopbackHost } from '../auth/callback'
import { cloudAuthPath, type CloudSignInMode } from '../../shared/managed-cloud'

export interface Tokens {
  accessToken: string
  refreshToken: string
  /** Seconds until the access token stops working. */
  expiresIn: number
  trust?: RunnerTrust | null
}

/** The runner said no: the code, token or account is not accepted. Trying again will not help. */
export class SignInRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignInRefusedError'
  }
}

const CALLBACK_PATH = '/callback'
/** The statuses a token endpoint turns a request down with. */
const REFUSALS = new Set([400, 401])
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

/** The runner's sign-in pages live at the http(s) form of the address the desktop connects to. */
export function httpBase(runnerUrl: string): string {
  return runnerUrl.replace(/^ws/, 'http').replace(/\/$/, '')
}

/** Asks the runner's token endpoint. A refusal and an unreachable runner are different errors. */
export async function requestTokens(
  _base: string,
  fields: Record<string, string>,
  transport?: RunnerTransport,
  signal?: AbortSignal
): Promise<Tokens> {
  if (transport === undefined) throw new HostProofError('The runner needs a verified TLS transport')
  const response = await transport.post('/auth/token', fields, signal)
  const value: unknown = await response.json().catch(() => null)
  const body =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  // A refusal is the runner's own answer: it names an error. Anything else that is not a
  // success, such as the TLS front answering while the runner restarts, means it was never
  // asked, and a sign-in must not be thrown away over that.
  if (REFUSALS.has(response.status) && typeof body['error'] === 'string') {
    throw new SignInRefusedError(
      typeof body['error_description'] === 'string'
        ? body['error_description']
        : 'The runner refused the sign-in'
    )
  }
  if (!response.ok) throw new Error(`The runner could not be reached (it answered ${response.status})`)
  if (
    typeof body['access_token'] !== 'string' ||
    body['access_token'] === '' ||
    typeof body['refresh_token'] !== 'string' ||
    body['refresh_token'] === '' ||
    typeof body['expires_in'] !== 'number' ||
    !Number.isFinite(body['expires_in']) ||
    body['expires_in'] <= 0
  ) {
    throw new Error('The runner returned an incomplete sign-in')
  }
  return {
    accessToken: body['access_token'],
    refreshToken: body['refresh_token'],
    expiresIn: body['expires_in']
  }
}

/** Signing out. The runner answers the same whether or not it knew the token. */
export async function revokeRefreshToken(
  _base: string,
  refreshToken: string,
  transport?: RunnerTransport
): Promise<void> {
  if (transport === undefined) throw new HostProofError('The runner needs a verified TLS transport')
  await transport.post('/auth/revoke', { token: refreshToken })
}

interface CodeExchange {
  mode?: CloudSignInMode
  base: string
  code: string
  redirectUri: string
  codeVerifier: string
  nonce: string
  expectedEmail: string
  development?: boolean
  signal?: AbortSignal
}

/** The verifier stays here until independent identity and TLS-key checks have both passed. */
export async function exchangeSignInCode(input: CodeExchange): Promise<Tokens> {
  input.signal?.throwIfAborted()
  let trust: RunnerTrust | null = null
  if (!(input.development === true && isLoopbackHost(new URL(input.base).hostname))) {
    const reply = await fetch(`${input.base}${cloudAuthPath(input.mode, 'proof')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: input.code, redirect_uri: input.redirectUri }),
      redirect: 'error',
      signal: AbortSignal.any([input.signal ?? AbortSignal.timeout(15000), AbortSignal.timeout(15000)])
    })
    if (!reply.ok) throw new SignInRefusedError('The runner refused the sign-in proof')
    const value = await readRunnerJson(reply)
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new HostProofError('The runner returned an invalid sign-in proof')
    const body = value as { id_token?: unknown; host_proof?: unknown }
    trust = await verifyHostProof({
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      base: input.base,
      nonce: input.nonce,
      expectedEmail: input.expectedEmail,
      idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
      proof: body.host_proof as HostProof | undefined
    })
  }
  input.signal?.throwIfAborted()
  const transport = createRunnerTransport({
    base: input.base,
    trust: async () => trust,
    ...(input.development === undefined ? {} : { development: input.development })
  })
  try {
    const tokens = await requestTokens(
      input.base,
      {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier
      },
      transport,
      input.signal
    )
    input.signal?.throwIfAborted()
    return { ...tokens, trust }
  } finally {
    transport.close()
  }
}

function page(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Loom</title><body style="font:16px system-ui;margin:15vh auto;max-width:28em;text-align:center">${message}</body>`
}

const RETURN_TIMEOUT_MS = 10 * 60 * 1000

export interface BrowserReturn {
  /** The address to send the browser back to: a port on this Mac itself. */
  callback: string
  /** Stops listening. */
  close(): void
}

/**
 * Listens on a port of this Mac's own for a browser to come back from somewhere it was sent.
 * `onReturn` is given what it came back with and answers with what the person should read;
 * if it throws, the visit is refused and the wait goes on, since any page on this Mac can
 * reach the port. Listening stops after the first visit that works, or when time runs out.
 */
export function listenForBrowser(input: {
  onReturn(query: URLSearchParams): Promise<string>
  timeoutMs?: number
}): Promise<BrowserReturn> {
  return new Promise((resolve, reject) => {
    const listener = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const answer = (status: number, message: string): void => {
        response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(message))
      }
      if (url.pathname !== CALLBACK_PATH) return answer(400, 'This is not something Loom is waiting for.')
      input.onReturn(url.searchParams).then(
        (message) => {
          answer(200, message)
          close()
        },
        () => answer(400, 'Loom could not finish this. Return to Loom and try again.')
      )
    })
    const close = (): void => {
      clearTimeout(timer)
      listener.close()
      listener.closeAllConnections()
    }
    const timer = setTimeout(close, input.timeoutMs ?? RETURN_TIMEOUT_MS)
    timer.unref()
    listener.once('error', reject)
    // Port 0: any free port. The loopback address, never a name that could resolve elsewhere.
    listener.listen(0, '127.0.0.1', () => {
      resolve({
        callback: `http://127.0.0.1:${(listener.address() as AddressInfo).port}${CALLBACK_PATH}`,
        close
      })
    })
  })
}

/**
 * RFC 8252: the desktop listens on a port of its own choosing on this Mac, sends the person
 * to the runner's sign-in page in their real browser, and waits for the browser to come back
 * to that port with a one-time code. The code is useless without the verifier kept here, and
 * a visit to the port is ignored unless it carries the state made here.
 */
export function signInThroughBrowser(input: {
  mode?: CloudSignInMode
  base: string
  expectedEmail: string
  openBrowser(url: string): void
  timeoutMs?: number
  /** Abandons the attempt: the port closes and the promise rejects with the signal's reason. */
  signal?: AbortSignal
  inviteSecret?: string
  development?: boolean
}): Promise<Tokens> {
  const verifier = newVerifier()
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  return new Promise((resolve, reject) => {
    let redirectUri = ''
    let finished = false
    let exchanging = false
    const finish = (outcome: () => void): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      listener.close()
      input.signal?.removeEventListener('abort', abort)
      outcome()
    }
    const listener = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const answer = (status: number, message: string): void => {
        response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(message))
      }
      if (url.pathname !== CALLBACK_PATH || url.searchParams.get('state') !== state) {
        return answer(400, 'This is not a sign-in that Loom started.')
      }
      if (finished || exchanging) return answer(409, 'Loom is already finishing this sign-in.')
      const code = url.searchParams.get('code')
      if (code === null) {
        answer(403, 'Loom could not sign you in with this account. You can close this tab.')
        return finish(() => reject(new SignInRefusedError('This account is not allowed to sign in')))
      }
      exchanging = true
      exchangeSignInCode({
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        base: input.base,
        code,
        redirectUri,
        codeVerifier: verifier,
        nonce,
        expectedEmail: input.expectedEmail,
        ...(input.development === undefined ? {} : { development: input.development }),
        ...(input.signal === undefined ? {} : { signal: input.signal })
      })
        .then(async (tokens) => {
          if (finished) throw new Error('This sign-in was abandoned')
          return tokens
        })
        .then(
          (tokens) => {
            answer(200, 'You are signed in to Loom. You can close this tab.')
            finish(() => resolve(tokens))
          },
          (error: unknown) => {
            answer(502, 'Loom could not finish signing you in. You can close this tab.')
            finish(() => reject(error instanceof Error ? error : new Error(String(error))))
          }
        )
    })
    const timer = setTimeout(
      () => finish(() => reject(new Error('Signing in took too long and was abandoned'))),
      input.timeoutMs ?? SIGN_IN_TIMEOUT_MS
    )
    listener.once('error', (error) => finish(() => reject(error)))
    const abort = (): void => finish(() => reject(input.signal?.reason as Error))
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) return abort()
    // Port 0: any free port. The loopback address, never a name that could resolve elsewhere.
    listener.listen(0, '127.0.0.1', async () => {
      redirectUri = `http://127.0.0.1:${(listener.address() as AddressInfo).port}${CALLBACK_PATH}`
      const query = new URLSearchParams({
        redirect_uri: redirectUri,
        code_challenge: challengeOf(verifier),
        state,
        nonce
      })
      try {
        if (input.inviteSecret !== undefined) {
          const response = await fetch(`${input.base}${cloudAuthPath(input.mode, 'invite')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              invite_secret: input.inviteSecret,
              code_challenge: challengeOf(verifier)
            }),
            redirect: 'error',
            signal:
              input.signal === undefined
                ? AbortSignal.timeout(15000)
                : AbortSignal.any([input.signal, AbortSignal.timeout(15000)])
          })
          if (!response.ok) throw new SignInRefusedError('This invite is expired, revoked, or already used')
        }
        if (!finished)
          input.openBrowser(`${input.base}${cloudAuthPath(input.mode, 'start')}?${query.toString()}`)
      } catch (error) {
        finish(() => reject(error))
      }
    })
  })
}
