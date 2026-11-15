import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { connectRunner } from '../src/main/cloud/client'

it('keeps personal calls working against older runners while refusing unsupported subscription administration locally', async () => {
  const server = createServer()
  const sockets = new WebSocketServer({ server })
  const seen: string[] = []
  sockets.on('connection', (socket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data))
      if (frame.type === 'hello') {
        socket.send(JSON.stringify({ type: 'hello', protocol: 6, capabilities: ['bots.v1'] }))
      } else {
        seen.push(frame.channel)
        socket.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, value: 'pong' }))
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  let connected = false
  const client = connectRunner({
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token: async () => 'fixture',
    onState: (state) => {
      connected = state.state === 'connected'
    },
    onPush: () => {}
  })
  try {
    await vi.waitFor(() => expect(connected).toBe(true))
    await expect(client.call('subscriptions:list', undefined)).rejects.toThrow(/subscription|update/i)
    await expect(client.call('app:ping', undefined)).resolves.toBe('pong')
    expect(seen).toEqual(['app:ping'])
  } finally {
    client.close()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>((resolve) => sockets.close(() => server.close(() => resolve())))
  }
})
