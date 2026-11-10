import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createRpcTransport, type RpcCall, type RpcId } from '../src/main/agents/cli/rpc'

const processes: EventEmitter[] = []
afterEach(() => {
  for (const child of processes.splice(0)) child.emit('close', 0, null)
})

function harness() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough()
  })
  processes.push(child)
  const calls: RpcCall[] = []
  const sent: Record<string, unknown>[] = []
  child.stdin.on('data', (chunk: Buffer) => sent.push(JSON.parse(chunk.toString())))
  const rpc = createRpcTransport(child, (call) => calls.push(call))
  const receive = (...messages: unknown[]) =>
    child.stdout.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n')
  return { child, calls, sent, rpc, receive }
}

describe('CLI JSON-RPC transport', () => {
  it('matches out-of-order responses to their originating requests', async () => {
    const { rpc, sent, receive } = harness()
    const first = rpc.request('thread/start', { model: 'test-model' })
    const second = rpc.request('model/list', {})
    receive({ id: sent[1]?.id, result: 'models' }, { id: sent[0]?.id, result: 'thread' })
    await expect(Promise.all([first, second])).resolves.toEqual(['thread', 'models'])
  })

  it('routes server questions independently of colliding request IDs and notifications', async () => {
    const { rpc, sent, receive, calls } = harness()
    const pending = rpc.request('turn/start', {})
    const id = sent[0]?.id as RpcId
    const question = { id, method: 'item/tool/requestUserInput', params: { questions: [] } }
    const notification = { method: 'turn/started', params: { turn: { id: 'active' } } }
    receive(question, notification)
    expect(calls).toEqual([question, notification])
    await rpc.respond(id, { answers: {} })
    expect(sent.at(-1)).toEqual({ id, result: { answers: {} } })
    await rpc.notify('initialized')
    expect(sent.at(-1)).toEqual({ method: 'initialized' })
    receive({ id, result: 'accepted' })
    await expect(pending).resolves.toBe('accepted')
    await rpc.reject('unsupported', -32601, 'Unsupported request')
    expect(sent.at(-1)).toEqual({
      id: 'unsupported',
      error: { code: -32601, message: 'Unsupported request' }
    })
  })

  it('preserves UTF-8 records split across chunks and combined with another record', async () => {
    const { rpc, sent, child, calls } = harness()
    const pending = rpc.request('thread/read', {})
    const bytes = Buffer.from(
      JSON.stringify({ id: sent[0]?.id, result: '🎛 café' }) + '\r\n{"method":"ready"}\n'
    )
    const split = bytes.indexOf(Buffer.from('🎛')) + 1
    child.stdout.write(bytes.subarray(0, split))
    child.stdout.write(bytes.subarray(split))
    await expect(pending).resolves.toBe('🎛 café')
    expect(calls).toEqual([{ method: 'ready' }])
  })

  it('rejects every pending request when the process exits and refuses further sends', async () => {
    const { rpc, child } = harness()
    const pending = Promise.allSettled([rpc.request('first'), rpc.request('second')])
    child.emit('close', 7, null)
    for (const result of await pending) {
      expect(result).toMatchObject({ status: 'rejected', reason: expect.any(Error) })
    }
    await expect(rpc.request('after-exit')).rejects.toThrow(/7/)
    await expect(rpc.notify('after-exit')).rejects.toThrow(/7/)
  })
})
