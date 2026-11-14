import WebSocket from 'ws'
import type { Agent } from 'node:https'
import type { RunnerTransport } from './transport'
import { HostProofError } from './host-proof'
import {
  CLOSE_SIGNED_OUT,
  CLOSE_UPDATE_REQUIRED,
  RUNNER_PATH,
  RUNNER_PROTOCOL,
  type ClientFrame,
  type RunnerFrame
} from '../../shared/runner-contract'

export type ClientState =
  { state: 'connecting' | 'connected' | 'unreachable' | 'signed-out' } | { state: 'update'; message: string }

/** How the desktop proves itself to a runner. */
export interface RunnerAuth {
  transport?: RunnerTransport
  /** The token to present on each connection; null when there is no sign-in to present. */
  token(): Promise<string | null>
  /** The runner turned the token away: whatever supplies tokens should renew before the next ask. */
  onRefused?(): void
}

export interface RunnerClientOptions extends RunnerAuth {
  /** ws:// or wss:// address of the runner, without a path. */
  url: string
  /** What this desktop speaks; a runner on another version ends in the `update` state. */
  protocol?: number
  onPush(channel: string, payload: unknown): void
  onState(state: ClientState): void
}

export interface RunnerClient {
  /** Rejects when the runner is not connected, or stops answering before it replies. */
  call(channel: string, input: unknown): Promise<unknown>
  /**
   * For a call that carries its own identity, such as a message with an ID: it is kept
   * across reconnects and sent again until it is answered, which the runner makes harmless
   * by running each identity once.
   */
  callIdentified(channel: string, input: unknown): Promise<unknown>
  /** Tries again now, after a sign-in or a change the connection could not have noticed. */
  reconnect(): void
  close(): void
}

export class RunnerUnreachableError extends Error {
  constructor(message = 'The cloud runner is unreachable') {
    super(message)
    this.name = 'RunnerUnreachableError'
  }
}

/** Out of reach for want of a sign-in: waiting will not bring the runner back, signing in will. */
export class SignedOutError extends RunnerUnreachableError {
  constructor() {
    super('Signed out of cloud. Sign in under Settings, Cloud, and try again.')
    this.name = 'SignedOutError'
  }
}

interface Pending {
  frame: ClientFrame
  identified: boolean
  /** True once it has gone out on some connection, so the runner may already be acting on it. */
  sent: boolean
  resolve(value: unknown): void
  reject(error: Error): void
}

const RETRY_FIRST_MS = 500
const RETRY_MAX_MS = 10_000
/** The runner pings every 30 seconds; this much silence means the connection is dead. */
const SILENCE_MS = 70_000

function updateMessage(ours: number, theirs: number): string {
  return ours < theirs
    ? 'Update Loom: this desktop is older than the cloud runner.'
    : 'The cloud runner is older than this desktop and needs updating.'
}

/** The desktop's one connection to a runner. It reconnects on its own until closed. */
export function connectRunner(options: RunnerClientOptions): RunnerClient {
  const protocol = options.protocol ?? RUNNER_PROTOCOL
  const pending = new Map<number, Pending>()
  let socket: WebSocket | null = null
  let ready = false
  let closed = false
  let nextId = 1
  let retryMs = RETRY_FIRST_MS
  let retryTimer: NodeJS.Timeout | undefined
  /** True once a token has been turned away with no good connection since. */
  let refused = false
  /** True while there is no sign-in to connect with: nothing more is tried until `reconnect`. */
  let signedOut = false
  /** Counts attempts, so one overtaken while it waited for its token gives way to the newer. */
  let attempts = 0
  let silenceTimer: NodeJS.Timeout | undefined

  function send(call: Pending): void {
    call.sent = true
    socket?.send(JSON.stringify(call.frame))
  }

  function heard(): void {
    clearTimeout(silenceTimer)
    silenceTimer = setTimeout(() => socket?.terminate(), SILENCE_MS)
    silenceTimer.unref()
  }

  /** Ordinary calls fail with the connection; identified ones wait for the next one. */
  function dropped(): void {
    ready = false
    clearTimeout(silenceTimer)
    for (const [id, call] of pending) {
      if (call.identified && !closed) continue
      pending.delete(id)
      call.reject(new RunnerUnreachableError())
    }
  }

  function stop(state: ClientState): void {
    closed = true
    clearTimeout(retryTimer)
    dropped()
    options.onState(state)
  }

  function receive(frame: RunnerFrame): void {
    if (frame.type === 'hello') {
      if (frame.protocol !== protocol) {
        return stop({ state: 'update', message: updateMessage(protocol, frame.protocol) })
      }
      ready = true
      refused = false
      retryMs = RETRY_FIRST_MS
      // Whatever was waiting for a connection goes out again, under the identity it had.
      for (const call of pending.values()) send(call)
      return options.onState({ state: 'connected' })
    }
    if (frame.type === 'push') return options.onPush(frame.channel, frame.payload)
    const call = pending.get(frame.id)
    if (call === undefined) return
    pending.delete(frame.id)
    if (frame.ok) call.resolve(frame.value)
    else call.reject(new Error(frame.error))
  }

  function retryLater(): void {
    options.onState({ state: 'unreachable' })
    retryTimer = setTimeout(() => void connect(), retryMs)
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
  }

  /**
   * Only a sign-in ends this, and nobody knows when that will be, so nothing may wait for
   * it unseen. A call that never went out fails here and now, and its message goes back to
   * whoever wrote it. One that did go out is kept: the runner may be running it, and calling
   * it failed would invite a second copy. It goes out again, under its identity, after the
   * sign-in.
   */
  function awaitSignIn(): void {
    signedOut = true
    for (const [id, call] of pending) {
      if (call.sent) continue
      pending.delete(id)
      call.reject(new SignedOutError())
    }
    options.onState({ state: 'signed-out' })
  }

  /**
   * One fresh token is worth trying, since an access token may simply have expired. Two
   * refusals in a row mean there is no sign-in the runner accepts, and asking again would
   * only loop; it waits for `reconnect`.
   */
  function turnedAway(): void {
    if (refused) return awaitSignIn()
    refused = true
    options.onRefused?.()
    void connect()
  }

  async function connect(): Promise<void> {
    const attempt = ++attempts
    const overtaken = (): boolean => closed || attempt !== attempts
    clearTimeout(retryTimer)
    signedOut = false
    options.onState({ state: 'connecting' })
    let bearer: string | null
    let agent: Agent | undefined
    try {
      bearer = await options.token()
      if (bearer !== null) {
        if (options.transport !== undefined) agent = await options.transport.websocketAgent()
        else if (options.url.startsWith('wss:'))
          throw new HostProofError('Sign in again to verify the runner transport')
      }
    } catch {
      // Renewing needs the runner too; if it cannot be reached, neither can a connection.
      return overtaken() ? undefined : retryLater()
    }
    if (overtaken()) {
      agent?.destroy()
      return
    }
    if (bearer === null) return awaitSignIn()
    let unauthorized = false
    const ws = new WebSocket(`${options.url}${RUNNER_PATH}`, {
      headers: { authorization: `Bearer ${bearer}` },
      agent,
      handshakeTimeout: 15000
    })
    socket = ws
    ws.on('open', () => {
      heard()
      ws.send(JSON.stringify({ type: 'hello', protocol } satisfies ClientFrame))
    })
    ws.on('ping', heard)
    ws.on('message', (data) => {
      heard()
      receive(JSON.parse(String(data)) as RunnerFrame)
    })
    // 'close' always follows. A 401 at the door is the one error that says something more.
    ws.on('error', (error) => {
      unauthorized = error.message.includes('401')
    })
    ws.on('close', (code) => {
      agent?.destroy()
      if (socket !== ws || closed) return
      socket = null
      if (code === CLOSE_UPDATE_REQUIRED) {
        return stop({ state: 'update', message: 'Loom and the cloud runner are different versions.' })
      }
      dropped()
      if (unauthorized || code === CLOSE_SIGNED_OUT) return turnedAway()
      retryLater()
    })
  }

  function request(channel: string, input: unknown, identified: boolean): Promise<unknown> {
    if (signedOut) return Promise.reject(new SignedOutError())
    if (closed || (!ready && !identified)) return Promise.reject(new RunnerUnreachableError())
    const id = nextId++
    return new Promise((resolve, reject) => {
      const call: Pending = {
        frame: { type: 'call', id, channel, input },
        identified,
        sent: false,
        resolve,
        reject
      }
      pending.set(id, call)
      if (ready) send(call)
    })
  }

  void connect()

  return {
    call: (channel, input) => request(channel, input, false),
    callIdentified: (channel, input) => request(channel, input, true),
    reconnect() {
      if (closed) return
      refused = false
      retryMs = RETRY_FIRST_MS
      // Forgotten before it is ended, so its close is not mistaken for the runner going away.
      const previous = socket
      socket = null
      previous?.terminate()
      dropped()
      void connect()
    },
    close() {
      if (closed) return
      closed = true
      clearTimeout(retryTimer)
      dropped()
      socket?.terminate()
      socket = null
    }
  }
}
