import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { isLoginProvider, PROVIDERS, type ProviderRules } from './providers'
import { standInUser, type LoginProvider } from './stand-in'
import type { Login, LoginVault } from './vault'

export interface LoginProxyOptions {
  host: string
  port: number
  /** The host's key; stand-ins are proved with it. */
  key: Buffer
  vault: LoginVault
  /** Whether this person may still use the host at all. */
  isAdmitted(userId: string): boolean
  /** Whose container a call from this address comes from; null when it is none of the runner's. */
  ownerAt(address: string): LoginCaller | Promise<LoginCaller>
  /** Host-only quota feedback; the exact admitted login fences account reconnects. */
  onResponse?(
    userId: string,
    provider: LoginProvider,
    workspaceId: string | undefined,
    status: number,
    headers: IncomingHttpHeaders,
    login: Login | null,
    path: string
  ): void
  /** One address in place of all of a provider's servers: for tests that stand in for them. */
  upstreams?: Partial<Record<LoginProvider, string>>
  /** Told about refusals: which agent, which call, why. Never a token. */
  onRefused?(note: string): void
}

export type LoginCaller = string | { userId: string; workspaceId: string } | null

/** Capacity is temporarily unavailable; a workspace's stand-in is still authenticated. */
export class LoginUnavailable extends Error {
  readonly headers: Record<string, string>
  constructor(
    message: string,
    readonly status: 429 | 503 = 503,
    retryAt?: number
  ) {
    super(message)
    this.headers =
      retryAt === undefined
        ? {}
        : {
            'retry-after': String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)))
          }
  }
}

export interface LoginProxy {
  port: number
  closeFor(userId: string): void
  close(): Promise<void>
}

/** Headers that belong to one connection, or that only say how the call reached the proxy. */
const NOT_FORWARDED = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // git announces a large push and waits to be told to go on; the proxy has said so already.
  'expect',
  'forwarded',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip'
])
/** A live connection keeps the two headers that ask for it. */
const KEPT_FOR_UPGRADE = new Set(['connection', 'upgrade'])

/** `login` is null for a call that goes on as anybody, to a server that allows it. */
type Admitted = {
  userId: string
  workspaceId: string | undefined
  provider: LoginProvider
  revision: number
  rules: ProviderRules
  login: Login | null
  target: URL
  path: string
}
type Refused = { status: number; message: string; headers?: Record<string, string> }

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Where the call came from. The proxy sits behind the host's TLS front, which adds the
 * caller's address as the last entry of X-Forwarded-For; entries before it are whatever the
 * caller claimed and are ignored. A call that did not come through the front is its own witness.
 */
function callerAddress(request: IncomingMessage): string {
  const direct = request.socket.remoteAddress ?? ''
  if (!isLoopback(direct)) return direct
  const forwarded = String(request.headers['x-forwarded-for'] ?? '')
  const last = forwarded.split(',').at(-1)?.trim() ?? ''
  return isIP(last) === 0 ? direct : last
}

function forwardable(headers: IncomingHttpHeaders, upgrade: boolean): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    if (NOT_FORWARDED.has(name) && !(upgrade && KEPT_FOR_UPGRADE.has(name))) continue
    out[name] = value
  }
  return out
}

/**
 * Stands between an agent in a container and the agent's own servers. The container holds
 * only a stand-in; the verified caller and workspace resolve either a personal login or
 * a granted organization subscription. Real credentials only reach the fixed provider
 * routes the agent needs, after current ownership and access checks.
 */
export async function startLoginProxy(options: LoginProxyOptions): Promise<LoginProxy> {
  const revisions = new Map<string, number>()
  const live = new Map<string, Set<() => void>>()
  let closed = false

  function watch(userId: string, close: () => void): () => void {
    const streams = live.get(userId) ?? new Set<() => void>()
    streams.add(close)
    live.set(userId, streams)
    return () => {
      streams.delete(close)
      if (streams.size === 0) live.delete(userId)
    }
  }

  function closeFor(userId: string): void {
    revisions.set(userId, (revisions.get(userId) ?? 0) + 1)
    for (const close of live.get(userId) ?? []) close()
    live.delete(userId)
  }

  function current(userId: string, revision: number): boolean {
    return !closed && options.isAdmitted(userId) && (revisions.get(userId) ?? 0) === revision
  }

  async function allowed(
    request: IncomingMessage,
    userId: string,
    revision: number,
    workspaceId?: string
  ): Promise<boolean> {
    const owner = await options.ownerAt(callerAddress(request))
    const id = typeof owner === 'string' ? owner : owner?.userId
    const workspace = typeof owner === 'string' ? undefined : owner?.workspaceId
    return id === userId && workspace === workspaceId && current(userId, revision)
  }

  async function admit(request: IncomingMessage): Promise<Admitted | Refused> {
    const url = new URL(request.url ?? '/', 'http://proxy')
    const [, name = '', ...rest] = url.pathname.split('/')
    if (!isLoginProvider(name)) return { status: 404, message: 'There is nothing at this address' }
    const rules: ProviderRules = PROVIDERS[name]
    const path = `/${rest.join('/')}`

    // gh presents its token under GitHub's own word for it; everything else says Bearer.
    const bearer = /^(?:Bearer|token) (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const userId = standInUser(options.key, name, bearer)
    if (userId === null) return { status: 401, message: `This is not a ${rules.label} login Loom issued` }
    const revision = revisions.get(userId) ?? 0
    const owner = await options.ownerAt(callerAddress(request))
    const workspaceId = typeof owner === 'string' ? undefined : owner?.workspaceId
    if (!(await allowed(request, userId, revision, workspaceId))) {
      return { status: 403, message: 'This login cannot be used from here' }
    }
    // Encoded dots and slashes could mean one path here and another at the server.
    const route = /%2e|%2f|%5c|\\/i.test(url.pathname) ? null : rules.route(path)
    if (route === null) {
      options.onRefused?.(`${name}: ${request.method ?? ''} ${path} is not a call the agent needs`)
      return { status: 403, message: `Loom does not pass ${path} on to ${rules.label}` }
    }
    let login: Login | null = null
    let unavailable: LoginUnavailable | undefined
    try {
      login = await options.vault.get(userId, name, workspaceId)
    } catch (error) {
      if (!(error instanceof LoginUnavailable)) throw error
      unavailable = error
    }
    if (!(await allowed(request, userId, revision, workspaceId)))
      return { status: 403, message: 'This login cannot be used from here' }
    if (unavailable !== undefined)
      return { status: unavailable.status, message: unavailable.message, headers: unavailable.headers }
    if (login === null && rules.openToAnybody !== true) {
      return {
        status: 401,
        message: `${rules.label} is not connected for your cloud workspaces. Connect it in Loom: Settings, ${name === 'github' ? 'Integrations' : 'Agents'}, Cloud.`
      }
    }
    const target = new URL(`${route.path}${url.search}`, options.upstreams?.[name] ?? route.origin)
    return { userId, workspaceId, provider: name, revision, rules, login, target, path }
  }

  function observe(admitted: Admitted, answer: IncomingMessage): void {
    if (!current(admitted.userId, admitted.revision)) return
    options.onResponse?.(
      admitted.userId,
      admitted.provider,
      admitted.workspaceId,
      answer.statusCode ?? 502,
      answer.headers,
      admitted.login,
      admitted.path
    )
  }

  function outgoing(request: IncomingMessage, admitted: Admitted, upgrade: boolean): IncomingHttpHeaders {
    const headers = forwardable(request.headers, upgrade)
    headers.host = admitted.target.host
    // Either the authorized credential replaces the stand-in, or nothing does.
    delete headers.authorization
    if (admitted.login !== null) admitted.rules.authorize(headers, admitted.login, admitted.path)
    return headers
  }

  function refusal(refused: Refused): string {
    return JSON.stringify({
      type: 'error',
      error: { type: 'loom_login_proxy', message: `Loom: ${refused.message}` }
    })
  }

  async function forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const admitted = await admit(request)
    if ('status' in admitted) {
      request.resume()
      response
        .writeHead(admitted.status, { ...admitted.headers, 'content-type': 'application/json' })
        .end(refusal(admitted))
      return
    }
    if (!current(admitted.userId, admitted.revision)) {
      request.resume()
      response
        .writeHead(403, { 'content-type': 'application/json' })
        .end(refusal({ status: 403, message: 'This login cannot be used from here' }))
      return
    }
    const send = admitted.target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = send(
      admitted.target,
      { method: request.method, headers: outgoing(request, admitted, false) },
      (answer) => {
        observe(admitted, answer)
        response.writeHead(answer.statusCode ?? 502, forwardable(answer.headers, false))
        answer.pipe(response)
      }
    )
    const unwatch = watch(admitted.userId, () => {
      upstream.destroy()
      response.destroy()
    })
    upstream.on('error', () => {
      if (response.destroyed) return
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
      response.end(refusal({ status: 502, message: `${admitted.rules.label} could not be reached` }))
    })
    response.on('close', () => {
      unwatch()
      upstream.destroy()
    })
    request.pipe(upstream)
  }

  /** Inspect the upgrade handshake; accepted WebSocket frames pass through exactly once. */
  async function join(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const admitted = await admit(request)
    if ('status' in admitted) {
      const body = refusal(admitted)
      const headers = Object.entries(admitted.headers ?? {})
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('')
      socket.end(
        `HTTP/1.1 ${admitted.status} Refused\r\ncontent-type: application/json\r\n` +
          `${headers}content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
      )
      return
    }
    if (!(await allowed(request, admitted.userId, admitted.revision, admitted.workspaceId))) {
      socket.destroy()
      return
    }
    const send = admitted.target.protocol === 'https:' ? httpsRequest : httpRequest
    let tunnel: Duplex | undefined
    const upstream = send(admitted.target, {
      method: request.method,
      headers: outgoing(request, admitted, true)
    })
    const close = (): void => {
      upstream.destroy()
      tunnel?.destroy()
      socket.destroy()
    }
    const unwatch = watch(admitted.userId, close)
    const responseHead = (answer: IncomingMessage, upgraded: boolean): string => {
      const headers = forwardable(answer.headers, upgraded)
      if (!upgraded) headers.connection = 'close'
      const lines = Object.entries(headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value ?? '']).map((one) => `${name}: ${one}`)
      )
      return `HTTP/1.1 ${answer.statusCode ?? 502} ${answer.statusMessage ?? ''}\r\n${lines.join('\r\n')}\r\n\r\n`
    }
    upstream.once('response', (answer) => {
      observe(admitted, answer)
      socket.write(responseHead(answer, false))
      answer.pipe(socket)
    })
    upstream.once('upgrade', (answer, joined, upstreamHead) => {
      tunnel = joined
      void allowed(request, admitted.userId, admitted.revision, admitted.workspaceId)
        .then((accepted) => {
          if (!accepted || socket.destroyed || joined.destroyed) return close()
          observe(admitted, answer)
          socket.write(responseHead(answer, true))
          if (upstreamHead.length > 0) socket.write(upstreamHead)
          if (head.length > 0) joined.write(head)
          socket.pipe(joined)
          joined.pipe(socket)
          joined.on('error', close)
          joined.on('close', () => socket.destroy())
        })
        .catch(close)
    })
    upstream.on('error', close)
    socket.on('error', close)
    socket.on('close', () => {
      unwatch()
      upstream.destroy()
      tunnel?.destroy()
    })
    upstream.end()
  }

  const fail = (response: ServerResponse) => (): void => {
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
  const server = createServer((request, response) => void forward(request, response).catch(fail(response)))
  server.on(
    'upgrade',
    (request, socket, head) => void join(request, socket, head).catch(() => socket.destroy())
  )
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, resolve)
  })

  return {
    port: (server.address() as AddressInfo).port,
    closeFor,
    close: () =>
      new Promise((resolve) => {
        closed = true
        for (const userId of live.keys()) closeFor(userId)
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
