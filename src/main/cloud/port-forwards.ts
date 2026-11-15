import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import WebSocket, { createWebSocketStream } from 'ws'
import type { Agent } from 'node:https'
import type { RunnerTransport } from './transport'
import { HostProofError } from './host-proof'
import { RUNNER_CAPABILITIES, RUNNER_CAPABILITIES_HEADER } from '../../shared/runner-capabilities'
import type { PortForward } from '../../shared/ipc-contract'
import { RUNNER_FORWARD_PATH, RUNNER_PROTOCOL } from '../../shared/runner-contract'

interface ForwardOptions {
  transport?: RunnerTransport
  url: string
  token(): Promise<string | null>
  isConnected(): boolean
  check(workspaceId: string): Promise<void>
}

interface Mapping extends PortForward {
  workspaceId: string
  server: Server
  sockets: Set<Socket>
}

/** Local listeners belong to this desktop and close with its sign-in. No ports open on the host. */
export function createPortForwards(options: ForwardOptions) {
  const mappings = new Map<string, Mapping>()
  const pending = new Map<string, Promise<PortForward>>()
  const cancelled = new Set<string>()
  let closed = false
  const keyOf = (workspaceId: string, port: number) => `${workspaceId}:${port}`

  async function tunnel(mapping: Mapping, socket: Socket): Promise<void> {
    let agent: Agent | undefined
    socket.pause()
    mapping.sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => mapping.sockets.delete(socket))
    try {
      const bearer = await options.token()
      if (bearer !== null) {
        if (options.transport !== undefined) agent = await options.transport.websocketAgent()
        else if (options.url.startsWith('wss:'))
          throw new HostProofError('The runner needs a verified TLS transport')
      }
      if (
        closed ||
        !options.isConnected() ||
        bearer === null ||
        socket.destroyed ||
        !mapping.server.listening
      ) {
        agent?.destroy()
        return void socket.destroy()
      }
      const ws = new WebSocket(
        `${options.url}${RUNNER_FORWARD_PATH}/${mapping.workspaceId}/${mapping.port}?protocol=${RUNNER_PROTOCOL}`,
        {
          headers: {
            authorization: `Bearer ${bearer}`,
            [RUNNER_CAPABILITIES_HEADER]: RUNNER_CAPABILITIES.join(',')
          },
          handshakeTimeout: 10_000,
          maxPayload: 128 * 1024,
          perMessageDeflate: false,
          agent
        }
      )
      const stream = createWebSocketStream(ws, { highWaterMark: 64 * 1024 })
      const close = () => {
        socket.destroy()
        stream.destroy()
        ws.terminate()
      }
      socket.once('close', close)
      stream.on('error', close)
      ws.on('error', close)
      ws.once('close', () => agent?.destroy())
      // A normal WebSocket EOF must flush through the local socket before its teardown.
      stream.once('end', () => stream.end())
      socket.pipe(stream).pipe(socket)
      socket.resume()
    } catch {
      agent?.destroy()
      socket.destroy()
    }
  }

  async function remove(key: string): Promise<void> {
    cancelled.add(key)
    const mapping = mappings.get(key)
    if (mapping === undefined) return
    mappings.delete(key)
    for (const socket of mapping.sockets) socket.destroy()
    await new Promise<void>((resolve) => mapping.server.close(() => resolve()))
  }

  const service = {
    list(workspaceId: string): PortForward[] {
      return [...mappings.values()]
        .filter((mapping) => mapping.workspaceId === workspaceId)
        .map(({ port, localPort }) => ({ port, localPort }))
    },
    forward(workspaceId: string, port: number, localPort = 0): Promise<PortForward> {
      if (closed || !options.isConnected())
        return Promise.reject(new Error('The cloud runner is unreachable'))
      const key = keyOf(workspaceId, port)
      const existing = mappings.get(key)
      if (existing !== undefined) return Promise.resolve({ port, localPort: existing.localPort })
      const waiting = pending.get(key)
      if (waiting !== undefined) return waiting
      if (
        service.list(workspaceId).length +
          [...pending.keys()].filter((key) => key.startsWith(`${workspaceId}:`)).length >=
        10
      )
        return Promise.reject(new Error('A workspace can forward up to ten ports'))
      cancelled.delete(key)
      const work = (async () => {
        await options.check(workspaceId)
        if (closed || cancelled.has(key)) throw new Error('Port forwarding was cancelled')
        const server = createServer()
        const mapping: Mapping = { workspaceId, port, localPort, server, sockets: new Set() }
        server.on('connection', (socket) => {
          if (mapping.sockets.size >= 64 || !options.isConnected()) {
            socket.destroy()
            return
          }
          void tunnel(mapping, socket)
        })
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(localPort, '127.0.0.1', () => {
            server.off('error', reject)
            resolve()
          })
        })
        // close/sign-out can win while the OS is still allocating a port.
        if (closed || cancelled.has(key) || !options.isConnected()) {
          server.close()
          throw new Error('Port forwarding was cancelled')
        }
        server.on('error', () => {
          void remove(key)
        })
        mapping.localPort = (server.address() as AddressInfo).port
        mappings.set(key, mapping)
        return { port, localPort: mapping.localPort }
      })().finally(() => pending.delete(key))
      pending.set(key, work)
      return work
    },
    unforward: (workspaceId: string, port: number) => remove(keyOf(workspaceId, port)),
    async closeWorkspace(workspaceId: string): Promise<void> {
      for (const key of pending.keys()) if (key.startsWith(`${workspaceId}:`)) cancelled.add(key)
      await Promise.all(
        [...mappings].filter(([, mapping]) => mapping.workspaceId === workspaceId).map(([key]) => remove(key))
      )
    },
    disconnect(): void {
      for (const mapping of mappings.values()) for (const socket of mapping.sockets) socket.destroy()
    },
    async clear(): Promise<void> {
      for (const key of pending.keys()) cancelled.add(key)
      await Promise.all([...mappings.keys()].map(remove))
    },
    async close(): Promise<void> {
      closed = true
      await Promise.all([...mappings.keys()].map(remove))
      await Promise.allSettled([...pending.values()])
    }
  }
  return service
}
