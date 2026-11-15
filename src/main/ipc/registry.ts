import type Database from 'better-sqlite3'
import type { ZodType } from 'zod'
import { ipcSchemas, type IpcContract, type SecretPresence } from '../../shared/ipc-contract'
import type { SecretId } from '../../shared/models'
import { maskSecret, type SecretStore } from '../secrets'

/**
 * Handlers register here without knowing what will call them. The desktop exposes the
 * registry to its window through Electron; the runner exposes it over a WebSocket. Both
 * reach a handler only through its input schema.
 */
export interface IpcDeps {
  db: Database.Database
  secrets: SecretStore
  dataRoot: string
}

/**
 * Who a call comes from, when the transport knows. The desktop's window is the one user of
 * this Mac, so it passes none; a runner passes the signed-in user of the connection.
 */
export interface Caller {
  userId: string
  /** The sign-in the connection came in on; absent for a developer's stand-in token. */
  signInId?: string
  /** Transport callers always supply an array; undefined is reserved for internal calls. */
  capabilities?: readonly string[]
}

interface Registration {
  schema: ZodType
  fn: (input: never, caller?: Caller) => unknown
}

const registrations = new Map<string, Registration>()

type ChannelListener = (channel: string) => void

let announce: ChannelListener | null = null

/**
 * The transport that exposes handlers introduces itself here. It hears about every
 * registration, including the ones made before it arrived.
 */
export function onChannelRegistered(listener: ChannelListener): void {
  announce = listener
  for (const channel of registrations.keys()) listener(channel)
}

/** Registers under an explicit schema; a later registration replaces an earlier one. */
export function register<In, Out>(
  channel: string,
  schema: ZodType<In>,
  fn: (input: In, caller?: Caller) => Promise<Out> | Out
): void {
  registrations.set(channel, { schema, fn })
  announce?.(channel)
}

type Handler<K extends keyof IpcContract> = (
  input: IpcContract[K]['in'],
  caller?: Caller
) => Promise<IpcContract[K]['out']> | IpcContract[K]['out']

export function handle<K extends keyof IpcContract>(channel: K, fn: Handler<K>): void {
  register(channel, ipcSchemas[channel] as ZodType<IpcContract[K]['in']>, fn)
}

export class UnknownChannelError extends Error {
  constructor(channel: string) {
    super(`no handler is registered for ${channel}`)
    this.name = 'UnknownChannelError'
  }
}

function registration(channel: string): Registration {
  const found = registrations.get(channel)
  if (found === undefined) throw new UnknownChannelError(channel)
  return found
}

/** Runtime validation for a channel's input; TypeScript types do not exist at runtime. */
export function parseInput(channel: string, input: unknown): unknown {
  return registration(channel).schema.parse(input)
}

/** Calls a handler with input that `parseInput` has already validated. */
export function call(channel: string, parsed: unknown, caller?: Caller): unknown {
  return registration(channel).fn(parsed as never, caller)
}

export function dispatch(channel: string, input: unknown, caller?: Caller): unknown {
  return call(channel, parseInput(channel, input), caller)
}

export function registeredChannels(): string[] {
  return [...registrations.keys()]
}

/** Dev-time guard: every contract channel must have a handler (review finding #13). */
export function missingChannelHandlers(): string[] {
  return Object.keys(ipcSchemas).filter((channel) => !registrations.has(channel))
}

/** Whether a stored key exists, masked for display; the raw value never crosses the bridge. */
export async function secretPresence(secrets: SecretStore, id: SecretId): Promise<SecretPresence> {
  const value = await secrets.get(id)
  return value === null ? { present: false, masked: null } : { present: true, masked: maskSecret(value) }
}
