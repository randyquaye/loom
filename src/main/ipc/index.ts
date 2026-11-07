import { ipcSchemas, type IpcContract, type SecretPresence } from '../../shared/ipc-contract'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type Database from 'better-sqlite3'
import { BACKEND_IDS, type AuthStatus, type BackendId } from '../../shared/models'
import { authStatusFor, getBackend } from '../agents/registry'
import { maskSecret, type SecretStore } from '../secrets'
import { registerCommentsIpc } from './comments'
import { registerEnvIpc } from './env'
import { registerExportIpc } from './export'
import { registerFilesIpc } from './files'
import { registerGithubIpc } from './github'
import { registerGitIpc } from './git'
import { registerHistoryIpc } from './history'
import { registerInstructionsIpc } from './instructions'
import { registerIntegrationsIpc } from './integrations'
import { registerLinearIpc } from './linear'
import { registerLintIpc } from './lint'
import { registerProjectsIpc } from './projects'
import { registerSessionsIpc } from './sessions'
import { registerShellIpc } from './shell'
import { registerTerminalIpc } from './terminal'
import { registerWorkspacesIpc } from './workspaces'

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

export { maskSecret }

export function registerIpc(deps: IpcDeps): void {
  handle('app:ping', () => 'pong')

  handle('secrets:has', async ({ provider }): Promise<SecretPresence> => {
    const value = await deps.secrets.get(provider)
    return value === null ? { present: false, masked: null } : { present: true, masked: maskSecret(value) }
  })
  handle('secrets:set', ({ provider, value }) => deps.secrets.set(provider, value))
  handle('secrets:delete', ({ provider }) => deps.secrets.delete(provider))

  handle('providers:status', async (): Promise<Record<BackendId, AuthStatus>> => {
    const settled = await Promise.allSettled(
      BACKEND_IDS.map(async (backendId) => {
        const registered = getBackend(backendId)
        const status =
          registered === undefined
            ? await authStatusFor(backendId, deps.secrets)
            : await registered.authStatus()
        return [backendId, status] as const
      })
    )
    const out = {} as Record<BackendId, AuthStatus>
    settled.forEach((result, index) => {
      const backendId = BACKEND_IDS[index] as BackendId
      out[backendId] =
        result.status === 'fulfilled' ? result.value[1] : { state: 'error', message: String(result.reason) }
    })
    return out
  })

  handle('providers:models', async ({ backend }) => (await getBackend(backend)?.listModels()) ?? [])

  registerProjectsIpc(deps)
  registerWorkspacesIpc(deps)
  registerGitIpc(deps)
  registerGithubIpc(deps)
  registerIntegrationsIpc(deps)
  registerLinearIpc(deps)
  registerEnvIpc(deps)
  registerFilesIpc(deps)
  registerLintIpc(deps)
  registerTerminalIpc(deps)
  registerHistoryIpc(deps)
  registerExportIpc(deps)
  registerSessionsIpc(deps)
  registerCommentsIpc(deps)
  registerInstructionsIpc(deps)
  registerShellIpc()
}
