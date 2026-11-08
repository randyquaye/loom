import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type Database from 'better-sqlite3'
import { ipcSchemas, type IpcContract, type SecretPresence } from '../../shared/ipc-contract'
import type { SecretId } from '../../shared/models'
import { maskSecret, type SecretStore } from '../secrets'

/**
 * The IPC registration primitive, kept apart from index.ts so the per-area modules
 * import it without an import cycle through the module that registers them all.
 */
export interface IpcDeps {
  db: Database.Database
  secrets: SecretStore
  dataRoot: string
}

let trustedOrigin: string | null = null

/** Set once at startup: the dev server origin, or file:// when packaged. */
export function setTrustedOrigin(origin: string): void {
  trustedOrigin = origin
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? ''
  if (trustedOrigin === null || !url.startsWith(trustedOrigin)) {
    throw new Error(`ipc rejected: untrusted sender frame ${url}`)
  }
}

type Handler<K extends keyof IpcContract> = (
  input: IpcContract[K]['in']
) => Promise<IpcContract[K]['out']> | IpcContract[K]['out']

export function handle<K extends keyof IpcContract>(channel: K, fn: Handler<K>): void {
  registeredChannels.add(channel)
  ipcMain.handle(channel, (event, input: unknown) => {
    assertTrustedSender(event)
    const parsed = ipcSchemas[channel].parse(input) as IpcContract[K]['in']
    return fn(parsed)
  })
}

const registeredChannels = new Set<string>()

/** Dev-time guard: every contract channel must have a handler (review finding #13). */
export function missingChannelHandlers(): string[] {
  return Object.keys(ipcSchemas).filter((channel) => !registeredChannels.has(channel))
}

/** Whether a stored key exists, masked for display; the raw value never crosses the bridge. */
export async function secretPresence(secrets: SecretStore, id: SecretId): Promise<SecretPresence> {
  const value = await secrets.get(id)
  return value === null ? { present: false, masked: null } : { present: true, masked: maskSecret(value) }
}
