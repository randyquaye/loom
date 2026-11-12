import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as connectPlain, isIP, type AddressInfo, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as connectTls } from 'node:tls'
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
  ownerAt(address: string): string | null | Promise<string | null>
  /** One address in place of all of a provider's servers: for tests that stand in for them. */
  upstreams?: Partial<Record<LoginProvider, string>>
  /** Told about refusals: which agent, which call, why. Never a token. */
  onRefused?(note: string): void
}

export interface LoginProxy {
  port: number
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
type Admitted = { rules: ProviderRules; login: Login | null; target: URL; path: string }
type Refused = { status: number; message: string }

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
 * only a stand-in; here it is exchanged for its owner's real login, on the calls the agent
 * needs and nothing else. A real login is never sent anywhere but to its own agent's server,
 * and never on behalf of anyone but the person it belongs to.
 */
export async function startLoginProxy(options: LoginProxyOptions): Promise<LoginProxy> {
  async function admit(request: IncomingMessage): Promise<Admitted | Refused> {
    const url = new URL(request.url ?? '/', 'http://proxy')
    const [, name = '', ...rest] = url.pathname.split('/')
    if (!isLoginProvider(name)) return { status: 404, message: 'There is nothing at this address' }
    const rules: ProviderRules = PROVIDERS[name]
    const path = `/${rest.join('/')}`

    // gh presents its token under GitHub's own word for it; everything else says Bearer.
    const bearer = /^(?:Bearer|token) (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? ''
    const owner = await options.ownerAt(callerAddress(request))
    const userId = standInUser(options.key, name, bearer)
    if (userId === null) return { status: 401, message: `This is not a ${rules.label} login Loom issued` }
    if (!options.isAdmitted(userId) || userId !== owner) {
      return { status: 403, message: 'This login cannot be used from here' }
    }
    // Encoded dots and slashes could mean one path here and another at the server.
    const route = /%2e|%2f|%5c|\\/i.test(url.pathname) ? null : rules.route(path)
    if (route === null) {
      options.onRefused?.(`${name}: ${request.method ?? ''} ${path} is not a call the agent needs`)
      return { status: 403, message: `Loom does not pass ${path} on to ${rules.label}` }
    }
    const login = await options.vault.get(userId, name)
    if (login === null && rules.openToAnybody !== true) {
      return {
        status: 401,
        message: `${rules.label} is not connected for your cloud workspaces. Connect it in Loom: Settings, ${name === 'github' ? 'Integrations' : 'Agents'}, Cloud.`
      }
    }
    const target = new URL(`${route.path}${url.search}`, options.upstreams?.[name] ?? route.origin)
    return { rules, login, target, path }
  }

  function outgoing(request: IncomingMessage, admitted: Admitted, upgrade: boolean): IncomingHttpHeaders {
    const headers = forwardable(request.headers, upgrade)
    headers.host = admitted.target.host
    // Either the owner's real login goes on in the stand-in's place, or nothing does.
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
      response.writeHead(admitted.status, { 'content-type': 'application/json' }).end(refusal(admitted))
      return
    }
    const send = admitted.target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = send(
      admitted.target,
      { method: request.method, headers: outgoing(request, admitted, false) },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, forwardable(answer.headers, false))
        answer.pipe(response)
      }
    )
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
      response.end(refusal({ status: 502, message: `${admitted.rules.label} could not be reached` }))
    })
    response.on('close', () => upstream.destroy())
    request.pipe(upstream)
  }

  /** Codex talks to its server over one long connection; it is joined end to end, not read. */
  async function join(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const admitted = await admit(request)
    if ('status' in admitted) {
      const body = refusal(admitted)
      socket.end(
        `HTTP/1.1 ${admitted.status} Refused\r\ncontent-type: application/json\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
      )
      return
    }
    const { target } = admitted
    const secure = target.protocol === 'https:'
    const port = Number(target.port) || (secure ? 443 : 80)
    const upstream: Socket = secure
      ? connectTls({ host: target.hostname, port, servername: target.hostname })
      : connectPlain({ host: target.hostname, port })
    upstream.once(secure ? 'secureConnect' : 'connect', () => {
      const lines = Object.entries(outgoing(request, admitted, true)).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value ?? '']).map((one) => `${name}: ${one}`)
      )
      upstream.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
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
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}
