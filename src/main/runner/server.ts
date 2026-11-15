import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  clientFrame,
  CLOSE_SIGNED_OUT,
  CLOSE_UPDATE_REQUIRED,
  RUNNER_PATH,
  RUNNER_FORWARD_PATH,
  RUNNER_PROTOCOL,
  type RunnerFrame
} from '../../shared/runner-contract'
import type { Caller } from '../ipc/registry'
import { RUNNER_CAPABILITIES, RUNNER_CAPABILITIES_HEADER } from '../../shared/runner-capabilities'
import { createForwardingServer, type ForwardTarget } from './forwarding'

export interface RunnerServerOptions {
  host: string
  port: number
  /** Optional features implemented by this runner; omitted uses this build's features. */
  capabilities?: readonly string[]
  /** Answers ordinary requests, which is how people sign in; without it there are none. */
  http?: RequestListener | undefined
  /** Says who a bearer token belongs to; null refuses the connection. */
  authenticate(bearer: string): Caller | null
  /** Asked before every call and on every heartbeat; false ends the connection. */
  stillAllowed(caller: Caller): boolean
  /** Answers one call on behalf of the connection's user. */
  dispatch(caller: Caller, channel: string, input: unknown): unknown
  forward?: (caller: Caller, workspaceId: string, port: number) => Promise<ForwardTarget>
  /** Current workspace authority, rechecked for pending and live byte streams. */
  mayForward?(caller: Caller, workspaceId: string): boolean
  /** Projects a push for one connection; undefined suppresses that connection's update. */
  pushFor?(caller: Caller, channel: string, payload: unknown, workspaceId?: string): unknown | undefined
}

export interface RunnerServer {
  readonly port: number
  /** Sends a live update to every desktop of one user that has completed its hello. */
  sendTo(userId: string | null, channel: string, payload: unknown, workspaceId?: string): void
  /** The users with at least one desktop connected. */
  connectedUsers(): string[]
  /** The workspaces with a connection live through a port forward. */
  forwardedWorkspaces(): string[]
  /** Ends the connections of whoever matches: their sign-in is over. */
  closeWhere(matches: (caller: Caller) => boolean): void
  closeWorkspaceForwards(workspaceId: string): void
  close(): Promise<void>
}

const HELLO_TIMEOUT_MS = 5000
const HEARTBEAT_MS = 30_000
/** The largest frame is an uploaded attachment, base64 encoded. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Compares secrets without telling a near miss from a far one by how long it takes. */
export function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

type Admission = { caller: Caller } | { status: number; reason: string }

/**
 * Decides before the WebSocket exists. A browser names the page it comes from in `Origin`,
 * and a web page must never drive agents, so any origin at all is refused; a desktop sends
 * none. After that, the bearer token says who is connecting.
 */
function admit(
  request: IncomingMessage,
  authenticate: RunnerServerOptions['authenticate'],
  supportedCapabilities: readonly string[]
): Admission {
  if (request.headers.origin !== undefined) return { status: 403, reason: 'Forbidden' }
  const header = request.headers.authorization ?? ''
  const caller = header.startsWith('Bearer ') ? authenticate(header.slice('Bearer '.length)) : null
  if (caller === null) return { status: 401, reason: 'Unauthorized' }
  const requested = request.headers[RUNNER_CAPABILITIES_HEADER]
  const names = (Array.isArray(requested) ? requested.join(',') : (requested ?? ''))
    .split(',')
    .map((name) => name.trim())
  return { caller: { ...caller, capabilities: supportedCapabilities.filter((name) => names.includes(name)) } }
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

function send(socket: WebSocket, frame: RunnerFrame): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
}

/**
 * The one connection a desktop holds to a runner. Calls arrive as frames and go through the
 * same registry, with the same input checks, that Electron's IPC feeds on the desktop; live
 * updates leave on the same socket.
 */
export function startRunnerServer(options: RunnerServerOptions): Promise<RunnerServer> {
  const supportedCapabilities = options.capabilities ?? RUNNER_CAPABILITIES
  const http = createServer(
    options.http ??
      ((_request, response) => {
        response.writeHead(404).end()
      })
  )
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  /** Connections that have completed their hello, each with the user it belongs to. */
  const greeted = new Map<WebSocket, Caller>()
  const alive = new WeakSet<WebSocket>()
  const forwarding = createForwardingServer({
    open: options.forward,
    stillAllowed: options.stillAllowed,
    ...(options.mayForward === undefined ? {} : { mayForward: options.mayForward })
  })

  http.on('upgrade', (request, socket, head) => {
    const forward = request.url?.startsWith(`${RUNNER_FORWARD_PATH}/`) ?? false
    if (request.url !== RUNNER_PATH && !forward) return reject(socket, 404, 'Not Found')
    const admission = admit(request, options.authenticate, supportedCapabilities)
    if ('status' in admission) return reject(socket, admission.status, admission.reason)
    if (forward) {
      void forwarding.upgrade(request, socket, head, admission.caller).catch(() => socket.destroy())
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit('connection', ws, admission.caller))
  })

  sockets.on('connection', (socket: WebSocket, caller: Caller) => {
    alive.add(socket)
    socket.on('pong', () => alive.add(socket))
    const helloTimer = setTimeout(() => socket.terminate(), HELLO_TIMEOUT_MS)

    socket.on('message', (data) => {
      let frame
      try {
        frame = clientFrame.parse(JSON.parse(String(data)))
      } catch {
        return socket.terminate()
      }
      if (frame.type === 'hello') {
        clearTimeout(helloTimer)
        send(socket, { type: 'hello', protocol: RUNNER_PROTOCOL, capabilities: caller.capabilities ?? [] })
        if (frame.protocol !== RUNNER_PROTOCOL) return socket.close(CLOSE_UPDATE_REQUIRED, 'update')
        greeted.set(socket, caller)
        return
      }
      if (!greeted.has(socket)) return socket.terminate()
      const { id, channel, input } = frame
      // A connection outlives the moment it was allowed in; each call asks again.
      if (!options.stillAllowed(caller)) {
        send(socket, { type: 'result', id, ok: false, error: 'You are no longer signed in' })
        return socket.close(CLOSE_SIGNED_OUT, 'signed out')
      }
      // then() also catches a handler that throws before it returns a promise.
      Promise.resolve()
        .then(() => options.dispatch(caller, channel, input))
        .then(
          (value) => send(socket, { type: 'result', id, ok: true, value }),
          (error: unknown) =>
            send(socket, {
              type: 'result',
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            })
        )
    })

    socket.on('close', () => {
      clearTimeout(helloTimer)
      greeted.delete(socket)
    })
    socket.on('error', () => socket.terminate())
  })

  // A desktop that vanished without closing (lid shut, network gone) is found by its silence.
  // The same round ends a connection that only listens, such as a terminal stream, once its
  // sign-in is over.
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      const caller = greeted.get(socket)
      if (caller !== undefined && !options.stillAllowed(caller)) {
        socket.close(CLOSE_SIGNED_OUT, 'signed out')
        continue
      }
      if (!alive.has(socket)) {
        socket.terminate()
        continue
      }
      alive.delete(socket)
      socket.ping()
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()

  return new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(options.port, options.host, () => {
      http.off('error', reject)
      resolve({
        port: (http.address() as AddressInfo).port,
        sendTo(userId, channel, payload, workspaceId) {
          if (userId === null) return
          for (const [socket, owner] of greeted) {
            if (owner.userId !== userId || socket.readyState !== socket.OPEN) continue
            const projected =
              options.pushFor === undefined ? payload : options.pushFor(owner, channel, payload, workspaceId)
            if (options.pushFor !== undefined && projected === undefined) continue
            send(socket, { type: 'push', channel, payload: projected })
          }
        },
        connectedUsers() {
          return [...new Set([...greeted.values()].map((owner) => owner.userId))]
        },
        forwardedWorkspaces: () => forwarding.workspaces(),
        closeWhere(matches) {
          forwarding.closeWhere(matches)
          for (const [socket, owner] of greeted) {
            if (matches(owner)) socket.close(CLOSE_SIGNED_OUT, 'signed out')
          }
        },
        closeWorkspaceForwards: (workspaceId) => forwarding.closeWorkspace(workspaceId),
        close() {
          clearInterval(heartbeat)
          forwarding.close()
          for (const socket of sockets.clients) socket.terminate()
          return new Promise((done) => http.close(() => done()))
        }
      })
    })
  })
}
