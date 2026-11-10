import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { num, str, sub, tryParseRecord } from './record'

export type RpcId = string | number
export interface RpcCall {
  method: string
  params?: unknown
  id?: RpcId
}

type RpcProcess = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout'> & {
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

/** Bidirectional JSONL transport; the caller owns spawning and stopping the child. */
export function createRpcTransport(child: RpcProcess, onCall: (call: RpcCall) => void) {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
  let nextId = 1
  let failure: Error | undefined
  let resolveClosed: (error: Error) => void
  const closed = new Promise<Error>((resolve) => {
    resolveClosed = resolve
  })

  function fail(error: Error): void {
    if (failure !== undefined) return
    failure = error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    resolveClosed(error)
    reader.close()
  }

  reader.on('line', (line) => {
    if (failure !== undefined) return
    const message = tryParseRecord(line)
    if (message === undefined) return fail(new Error('Invalid JSON-RPC message'))
    const method = str(message, 'method')
    // Server requests and client requests have independent ID spaces.
    if (method !== undefined) {
      const id = message['id']
      if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') {
        return fail(new Error('Invalid JSON-RPC request ID'))
      }
      onCall({ method, params: message['params'], ...(id === undefined ? {} : { id }) })
      return
    }
    const id = num(message, 'id')
    const request = id === undefined ? undefined : pending.get(id)
    if (id === undefined || request === undefined) return
    pending.delete(id)
    const error = sub(message, 'error')
    if (error !== undefined) {
      request.reject(
        Object.assign(new Error(str(error, 'message') ?? 'JSON-RPC request failed'), {
          code: num(error, 'code'),
          data: error['data']
        })
      )
    } else if ('result' in message) request.resolve(message['result'])
    else request.reject(new Error('Invalid JSON-RPC response'))
  })
  reader.once('error', fail)
  reader.once('close', () => fail(new Error('JSON-RPC output closed')))
  child.once('error', fail)
  child.once('close', (code, signal) => fail(new Error(`JSON-RPC process closed (${signal ?? code})`)))
  child.stdin.once('error', fail)

  function write(message: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (failure !== undefined) return reject(failure)
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          fail(error)
          reject(error)
        } else resolve()
      })
    })
  }

  return {
    get failure(): Error | undefined {
      return failure
    },
    closed,
    request(method: string, params?: unknown): Promise<unknown> {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        void write({ id, method, params }).catch((error: unknown) => {
          pending.delete(id)
          reject(error)
        })
      })
    },
    notify(method: string, params?: unknown): Promise<void> {
      return write({ method, params })
    },
    respond(id: RpcId, result: unknown): Promise<void> {
      return write({ id, result: result ?? null })
    },
    reject(id: RpcId, code: number, message: string): Promise<void> {
      return write({ id, error: { code, message } })
    }
  }
}
