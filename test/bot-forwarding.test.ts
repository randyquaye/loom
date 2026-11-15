import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { startRunnerServer, type RunnerServer } from '../src/main/runner/server'
import { RUNNER_PROTOCOL } from '../src/shared/runner-contract'

const servers: RunnerServer[] = []
const clients: WebSocket[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate()
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('bot forwarding grants', () => {
  it('fences an existing byte stream when workspace control is revoked without signing out', async () => {
    let control = true
    const input = new PassThrough()
    const output = new PassThrough()
    const close = vi.fn(() => {
      input.destroy()
      output.destroy()
    })
    const server = await startRunnerServer({
      host: '127.0.0.1',
      port: 0,
      authenticate: () => ({ userId: 'viewer' }),
      stillAllowed: () => true,
      dispatch: () => undefined,
      mayForward: () => control,
      forward: async () => ({ input, output, close })
    })
    servers.push(server)
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/v1/forward/workspace/3000?protocol=${RUNNER_PROTOCOL}`,
      { headers: { authorization: 'Bearer fixture' } }
    )
    clients.push(socket)
    await once(socket, 'open')
    const received: string[] = []
    socket.on('message', (message) => received.push(String(message)))
    const ended = once(socket, 'close')
    control = false
    output.write('private bytes after revocation')
    await Promise.race([
      ended,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Revoked stream stayed open')), 1000))
    ])
    expect(received).toEqual([])
    expect(close).toHaveBeenCalled()
  })

  it('rechecks workspace control after asynchronous target creation', async () => {
    let control = true
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const input = new PassThrough()
    const output = new PassThrough()
    const close = vi.fn(() => {
      input.destroy()
      output.destroy()
    })
    const opening = vi.fn(async () => {
      await barrier
      return { input, output, close }
    })
    const server = await startRunnerServer({
      host: '127.0.0.1',
      port: 0,
      authenticate: () => ({ userId: 'viewer' }),
      stillAllowed: () => true,
      dispatch: () => undefined,
      mayForward: () => control,
      forward: opening
    })
    servers.push(server)
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/v1/forward/workspace/3000?protocol=${RUNNER_PROTOCOL}`,
      { headers: { authorization: 'Bearer fixture' } }
    )
    clients.push(socket)
    socket.on('error', () => {})
    const response = new Promise<number>((resolve) =>
      socket.on('unexpected-response', (_request, reply) => {
        reply.resume()
        resolve(reply.statusCode ?? 0)
      })
    )
    await vi.waitFor(() => expect(opening).toHaveBeenCalled())
    control = false
    release()
    expect(await response).toBe(401)
    expect(close).toHaveBeenCalled()
  })
})
