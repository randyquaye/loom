import { once } from 'node:events'
import { createServer } from 'node:http'
import { createConnection, type AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectRunner, type ClientState } from '../src/main/cloud/client'
import { createPortForwards } from '../src/main/cloud/port-forwards'
import { startRunnerServer } from '../src/main/runner/server'
import type { Caller } from '../src/main/ipc/registry'

const closers: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})
const wait = (assertion: () => void) => vi.waitFor(assertion, { timeout: 1200, interval: 10 })

/** Frozen wire fixture: no imports from the current runner contract or server. */
async function oldPeer(initialCapabilities?: string[], advertisedProtocol = 6) {
  const http = createServer()
  const sockets = new WebSocketServer({ noServer: true })
  const requests: Array<{ path: string; capabilities: string | string[] | undefined }> = []
  const calls: Array<{ connection: number; channel: string }> = []
  let capabilities = initialCapabilities
  let connections = 0
  http.on('upgrade', (request, socket, head) => {
    requests.push({ path: request.url ?? '', capabilities: request.headers['x-loom-capabilities'] })
    const forward = request.url?.startsWith('/v1/forward/')
    if (forward && request.url !== '/v1/forward/workspace/4321?protocol=6') {
      socket.end('HTTP/1.1 426 Refused\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      if (forward) {
        ws.on('message', (data) => ws.send(data))
        return
      }
      const connection = ++connections
      let ready = false
      ws.on('message', (data) => {
        const frame = JSON.parse(String(data)) as {
          type: string
          protocol?: number
          id?: number
          channel?: string
        }
        if (frame.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello',
              protocol: advertisedProtocol,
              ...(capabilities === undefined ? {} : { capabilities })
            })
          )
          if (frame.protocol !== advertisedProtocol) {
            ws.close(4400, 'update')
            return
          }
          ready = true
          ws.send(
            JSON.stringify({
              type: 'push',
              channel: 'workspace:state',
              payload: { workspaceId: 'workspace', state: 'ready' }
            })
          )
          return
        }
        if (!ready || frame.channel === undefined) {
          ws.terminate()
          return
        }
        calls.push({ connection, channel: frame.channel })
        // Keep bot invocations pending so reconnect tests can exercise retained delivery.
        if (frame.channel === 'bots:invoke') return
        ws.send(
          JSON.stringify({
            type: 'result',
            id: frame.id,
            ok: true,
            value: frame.channel === 'app:ping' ? 'pong' : []
          })
        )
      })
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    for (const socket of sockets.clients) socket.terminate()
    sockets.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })
  return {
    url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}`,
    requests,
    calls,
    setCapabilities(next: string[] | undefined) {
      capabilities = next
    }
  }
}

function desktop(url: string, protocol?: number) {
  const states: ClientState[] = []
  const pushes: Array<{ channel: string; payload: unknown }> = []
  const client = connectRunner({
    url,
    token: async () => 'fixture',
    ...(protocol === undefined ? {} : { protocol }),
    onState: (state) => states.push(state),
    onPush: (channel, payload) => pushes.push({ channel, payload })
  })
  closers.push(() => client.close())
  return { client, states, pushes }
}

function connected(states: ClientState[]) {
  return states.filter((state) => state.state === 'connected')
}

async function rawClient(port: number, capabilities?: string) {
  const frames: Array<Record<string, unknown>> = []
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, {
    headers: {
      authorization: 'Bearer fixture',
      ...(capabilities === undefined ? {} : { 'x-loom-capabilities': capabilities })
    }
  })
  socket.on('message', (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>))
  socket.on('error', () => {})
  closers.push(() => socket.terminate())
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'hello', protocol: 6 }))
  await wait(() => expect(frames[0]?.['type']).toBe('hello'))
  return { socket, frames }
}

describe('independent desktop and runner releases', () => {
  it('honors an explicit desktop feature opt-out while personal calls continue working', async () => {
    const peer = await oldPeer(['bots.v1', 'subscriptions.v1'])
    const states: ClientState[] = []
    const client = connectRunner({
      url: peer.url,
      token: async () => 'fixture',
      capabilities: [],
      onState: (state) => states.push(state),
      onPush: () => {}
    })
    closers.push(() => client.close())
    await wait(() => expect(connected(states)).toHaveLength(1))
    expect(peer.requests[0]?.capabilities).toBe('')
    expect(connected(states)[0]).toMatchObject({ capabilities: [] })
    await expect(client.call('bots:list', undefined)).rejects.toThrow(/support|available|updat/i)
    await expect(client.call('subscriptions:list', undefined)).rejects.toThrow(/support|available|updat/i)
    await expect(client.call('app:ping', undefined)).resolves.toBe('pong')
    expect(peer.calls.map((call) => call.channel)).toEqual(['app:ping'])
  })

  it('negotiates only explicitly configured server features for calls and forwarded streams', async () => {
    const callers: Caller[] = []
    const server = await startRunnerServer({
      host: '127.0.0.1',
      port: 0,
      capabilities: ['bots.v1'],
      authenticate: () => ({ userId: 'member' }),
      stillAllowed: () => true,
      dispatch(caller) {
        callers.push(caller)
        return 'pong'
      },
      forward: async (caller) => {
        callers.push(caller)
        const stream = new PassThrough()
        return { input: stream, output: stream, close: () => stream.destroy() }
      }
    })
    closers.push(() => server.close())
    const modern = await rawClient(server.port, 'bots.v1,subscriptions.v1,mobile.v1')
    expect(modern.frames[0]).toMatchObject({ capabilities: ['bots.v1'] })
    modern.socket.send(JSON.stringify({ type: 'call', id: 1, channel: 'app:ping' }))
    await wait(() => expect(callers).toHaveLength(1))
    const forwarded = new WebSocket(`ws://127.0.0.1:${server.port}/v1/forward/workspace/4321?protocol=6`, {
      headers: {
        authorization: 'Bearer fixture',
        'x-loom-capabilities': 'bots.v1,subscriptions.v1,mobile.v1'
      }
    })
    forwarded.on('error', () => {})
    closers.push(() => forwarded.terminate())
    await once(forwarded, 'open')
    expect(callers.map((caller) => caller.capabilities)).toEqual([['bots.v1'], ['bots.v1']])
  })

  it('keeps literal protocol 6 personal RPC and push events working without a capability hello', async () => {
    const peer = await oldPeer()
    const fx = desktop(peer.url)
    await wait(() => expect(connected(fx.states)).toHaveLength(1))
    expect(connected(fx.states)[0]).toMatchObject({ capabilities: [] })
    await expect(fx.client.call('app:ping', undefined)).resolves.toBe('pong')
    await wait(() =>
      expect(fx.pushes).toContainEqual({
        channel: 'workspace:state',
        payload: { workspaceId: 'workspace', state: 'ready' }
      })
    )
    expect(String(peer.requests[0]?.capabilities).split(',')).toContain('bots.v1')
  })

  it('refuses an actually incompatible wire version rather than downgrading it', async () => {
    const peer = await oldPeer(undefined, 5)
    const fx = desktop(peer.url)
    await wait(() => expect(fx.states.at(-1)?.state).toBe('update'))
    expect(connected(fx.states)).toHaveLength(0)
    expect(peer.calls).toHaveLength(0)
    expect(peer.requests).toHaveLength(1)
  })

  it('never sends bot requests to an older runner without the capability', async () => {
    const peer = await oldPeer()
    const fx = desktop(peer.url)
    await wait(() => expect(connected(fx.states)).toHaveLength(1))
    await expect(fx.client.call('bots:list', undefined)).rejects.toThrow(/support|available|updat/i)
    await expect(fx.client.callIdentified('bots:create', { messageId: 'new-bot' })).rejects.toThrow(
      /support|available|updat/i
    )
    await expect(fx.client.call('app:ping', undefined)).resolves.toBe('pong')
    expect(peer.calls.map((call) => call.channel)).toEqual(['app:ping'])
  })

  it('clears capabilities and drops unsupported retained bot calls when reconnecting to an older peer', async () => {
    const peer = await oldPeer(['bots.v1'])
    const fx = desktop(peer.url)
    await wait(() => expect(connected(fx.states)).toHaveLength(1))
    expect(connected(fx.states)[0]).toMatchObject({ capabilities: ['bots.v1'] })
    const pending = fx.client.callIdentified('bots:invoke', { messageId: 'invocation' }).then(
      () => 'delivered',
      (error: unknown) => error
    )
    await wait(() => expect(peer.calls.filter((call) => call.channel === 'bots:invoke')).toHaveLength(1))
    peer.setCapabilities(undefined)
    fx.client.reconnect()
    await wait(() => expect(connected(fx.states)).toHaveLength(2))
    expect(connected(fx.states)[1]).toMatchObject({ capabilities: [] })
    expect(await pending).toBeInstanceOf(Error)
    expect(peer.calls.filter((call) => call.channel === 'bots:invoke')).toHaveLength(1)
    await expect(fx.client.call('app:ping', undefined)).resolves.toBe('pong')
  })

  it('keeps literal protocol 6 forwarding paths and transfers bytes to the frozen peer', async () => {
    const peer = await oldPeer()
    const forwards = createPortForwards({
      url: peer.url,
      token: async () => 'fixture',
      isConnected: () => true,
      check: async () => {}
    })
    closers.push(() => forwards.close())
    const mapping = await forwards.forward('workspace', 4321)
    const socket = createConnection({ host: '127.0.0.1', port: mapping.localPort })
    socket.on('error', () => {})
    closers.push(() => socket.destroy())
    await once(socket, 'connect')
    const received = once(socket, 'data')
    socket.write(Buffer.from('private development service'))
    expect(String((await received)[0])).toBe('private development service')
    expect(peer.requests).toEqual([
      { path: '/v1/forward/workspace/4321?protocol=6', capabilities: expect.stringContaining('bots.v1') }
    ])
  })

  it('adds capability metadata to the current server while legacy callers keep an isolated empty array', async () => {
    const identity: Caller = { userId: 'member', signInId: 'signin' }
    const callers: Caller[] = []
    const server = await startRunnerServer({
      host: '127.0.0.1',
      port: 0,
      authenticate: () => identity,
      stillAllowed: () => true,
      dispatch(caller) {
        callers.push(caller)
        return 'pong'
      }
    })
    closers.push(() => server.close())
    const legacy = await rawClient(server.port)
    expect(legacy.frames[0]).toMatchObject({ type: 'hello', protocol: 6, capabilities: [] })
    legacy.socket.send(JSON.stringify({ type: 'call', id: 1, channel: 'app:ping' }))
    const modern = await rawClient(server.port, 'future.v1, bots.v1, bots.v1')
    expect(modern.frames[0]).toMatchObject({ type: 'hello', protocol: 6, capabilities: ['bots.v1'] })
    modern.socket.send(JSON.stringify({ type: 'call', id: 2, channel: 'app:ping' }))
    await wait(() => expect(callers).toHaveLength(2))
    expect(callers[0]).toMatchObject({ userId: 'member', capabilities: [] })
    expect(callers[1]).toMatchObject({ userId: 'member', capabilities: ['bots.v1'] })
    expect(callers[0]).not.toBe(identity)
    expect(callers[1]).not.toBe(identity)
    expect(identity).not.toHaveProperty('capabilities')
  })

  it('lets the new desktop use bot calls only after the current server confirms the capability', async () => {
    const callers: Caller[] = []
    const server = await startRunnerServer({
      host: '127.0.0.1',
      port: 0,
      authenticate: () => ({ userId: 'member' }),
      stillAllowed: () => true,
      dispatch(caller, channel) {
        callers.push(caller)
        return channel === 'bots:list' ? [] : 'pong'
      }
    })
    closers.push(() => server.close())
    const fx = desktop(`ws://127.0.0.1:${server.port}`)
    await wait(() => expect(connected(fx.states)).toHaveLength(1))
    expect(connected(fx.states)[0]).toMatchObject({ capabilities: expect.arrayContaining(['bots.v1']) })
    await expect(fx.client.call('bots:list', undefined)).resolves.toEqual([])
    expect(callers[0]).toMatchObject({ capabilities: expect.arrayContaining(['bots.v1']) })
  })

  it('projects each push using that connection’s capabilities and workspace metadata', async () => {
    const seen: Array<{ capabilities: readonly string[] | undefined; workspaceId: string | undefined }> = []
    const server = await startRunnerServer({
      host: '127.0.0.1',
      port: 0,
      authenticate: () => ({ userId: 'member' }),
      stillAllowed: () => true,
      dispatch: () => 'pong',
      pushFor(caller, channel, payload, workspaceId) {
        seen.push({ capabilities: caller.capabilities, workspaceId })
        return channel === 'bots:changed' && !caller.capabilities?.includes('bots.v1') ? undefined : payload
      }
    })
    closers.push(() => server.close())
    const legacy = await rawClient(server.port)
    const modern = await rawClient(server.port, 'bots.v1')
    server.sendTo('member', 'bots:changed', { revision: 1 }, 'bot-workspace')
    server.sendTo('member', 'app:barrier', { done: true })
    await wait(() => expect(legacy.frames.some((frame) => frame['channel'] === 'app:barrier')).toBe(true))
    await wait(() => expect(modern.frames.some((frame) => frame['channel'] === 'app:barrier')).toBe(true))
    expect(legacy.frames.some((frame) => frame['channel'] === 'bots:changed')).toBe(false)
    expect(modern.frames.some((frame) => frame['channel'] === 'bots:changed')).toBe(true)
    expect(seen).toContainEqual({ capabilities: [], workspaceId: 'bot-workspace' })
    expect(seen).toContainEqual({ capabilities: ['bots.v1'], workspaceId: 'bot-workspace' })
  })

  it('decorates forwarded connections with their requested capabilities as well', async () => {
    const callers: Caller[] = []
    const server = await startRunnerServer({
      host: '127.0.0.1',
      port: 0,
      authenticate: () => ({ userId: 'member' }),
      stillAllowed: () => true,
      dispatch: () => 'pong',
      forward: async (caller) => {
        callers.push(caller)
        const stream = new PassThrough()
        return { input: stream, output: stream, close: () => stream.destroy() }
      }
    })
    closers.push(() => server.close())
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/v1/forward/workspace/4321?protocol=6`, {
      headers: { authorization: 'Bearer fixture', 'x-loom-capabilities': 'bots.v1' }
    })
    socket.on('error', () => {})
    closers.push(() => socket.terminate())
    await once(socket, 'open')
    expect(callers[0]).toMatchObject({ capabilities: ['bots.v1'] })
  })
})
