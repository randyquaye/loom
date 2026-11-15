import type { IncomingMessage } from 'node:http'
import { Transform, type Duplex, type Readable, type Writable } from 'node:stream'
import { createWebSocketStream, WebSocketServer, type WebSocket } from 'ws'
import { RUNNER_FORWARD_PATH, RUNNER_PROTOCOL, CLOSE_SIGNED_OUT } from '../../shared/runner-contract'
import type { Caller } from '../ipc/registry'

export interface ForwardTarget {
  input: Writable
  output: Readable
  close(): void
}

interface ForwardingOptions {
  open?: ((caller: Caller, workspaceId: string, port: number) => Promise<ForwardTarget>) | undefined
  stillAllowed(caller: Caller): boolean
  mayForward?(caller: Caller, workspaceId: string): boolean
}

function reject(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/** Byte streams, separately bounded from attachment frames, over the runner's existing TLS endpoint. */
export function createForwardingServer(options: ForwardingOptions) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false })
  const live = new Map<WebSocket, { caller: Caller; workspaceId: string }>()
  const alive = new WeakSet<WebSocket>()
  const pending = new Map<Duplex, { workspaceId: string; caller: Caller }>()
  let closed = false
  const allowed = (caller: Caller, workspaceId: string) =>
    options.stillAllowed(caller) && (options.mayForward?.(caller, workspaceId) ?? true)
  const heartbeat = setInterval(() => {
    for (const [socket, { caller, workspaceId }] of live) {
      if (!allowed(caller, workspaceId)) socket.close(CLOSE_SIGNED_OUT, 'access ended')
      else if (!alive.has(socket)) socket.terminate()
      else {
        alive.delete(socket)
        socket.ping()
      }
    }
  }, 30_000)
  heartbeat.unref()

  return {
    async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, caller: Caller): Promise<void> {
      const match = /^\/v1\/forward\/([A-Za-z0-9_-]{1,64})\/(\d{1,5})\?protocol=(\d+)$/.exec(
        request.url ?? ''
      )
      if (match === null || !request.url?.startsWith(`${RUNNER_FORWARD_PATH}/`)) return reject(socket, 404)
      const workspaceId = match[1]!
      const port = Number(match[2])
      if (Number(match[3]) !== RUNNER_PROTOCOL) return reject(socket, 426)
      if (closed || options.open === undefined || port < 1024 || port > 65535) return reject(socket, 404)
      if (
        [...live.values(), ...pending.values()].filter((stream) => stream.caller.userId === caller.userId)
          .length >= 64 ||
        pending.size >= 64
      )
        return reject(socket, 429)
      pending.set(socket, { workspaceId, caller })
      const timeout = setTimeout(() => socket.destroy(), 10_000)
      let target: ForwardTarget
      try {
        if (!allowed(caller, workspaceId)) return reject(socket, 401)
        target = await options.open(caller, workspaceId, port)
      } catch {
        return reject(socket, 404)
      } finally {
        pending.delete(socket)
        clearTimeout(timeout)
      }
      if (
        closed ||
        socket.destroyed ||
        target.input.destroyed ||
        target.output.destroyed ||
        !allowed(caller, workspaceId)
      ) {
        target.close()
        return reject(socket, 401)
      }
      try {
        sockets.handleUpgrade(request, socket, head, (ws) => {
          live.set(ws, { caller, workspaceId })
          alive.add(ws)
          ws.on('pong', () => alive.add(ws))
          const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 })
          // Check each direction inside the stream, before a byte reaches its destination.
          const guard = () =>
            new Transform({
              transform(chunk, _encoding, done) {
                if (allowed(caller, workspaceId)) done(null, chunk)
                else done(new Error('Workspace access ended'))
              }
            })
          const incoming = guard()
          const outgoing = guard()
          let ended = false
          const close = () => {
            if (ended) return
            ended = true
            live.delete(ws)
            stream.destroy()
            incoming.destroy()
            outgoing.destroy()
            target.close()
            ws.terminate()
          }
          for (const part of [stream, incoming, outgoing, target.input, target.output])
            part.on('error', close)
          ws.on('error', close)
          ws.on('close', close)
          stream.pipe(incoming).pipe(target.input)
          target.output.pipe(outgoing).pipe(stream)
        })
      } catch {
        target.close()
        socket.destroy()
      }
    },
    /** The workspaces with a connection live through a forward right now. */
    workspaces(): string[] {
      return [...live.values()].map(({ workspaceId }) => workspaceId)
    },
    closeWhere(matches: (caller: Caller) => boolean): void {
      for (const [socket, { caller }] of pending) if (matches(caller)) socket.destroy()
      for (const [socket, { caller }] of live)
        if (matches(caller)) socket.close(CLOSE_SIGNED_OUT, 'signed out')
    },
    closeWorkspace(workspaceId: string): void {
      for (const [socket, owner] of pending) if (owner.workspaceId === workspaceId) socket.destroy()
      for (const [socket, owner] of live) if (owner.workspaceId === workspaceId) socket.terminate()
    },
    close(): void {
      closed = true
      clearInterval(heartbeat)
      for (const socket of pending.keys()) socket.destroy()
      for (const socket of sockets.clients) socket.terminate()
      sockets.close()
    }
  }
}
