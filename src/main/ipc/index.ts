import { BACKEND_IDS, type AuthStatus, type BackendId } from '../../shared/models'
import { authStatusFor, getBackend } from '../agents/registry'
import { handle, secretPresence, type IpcDeps } from './registry'
import { registerCloudIpc } from './cloud'
import { registerCommentsIpc } from './comments'
import { registerEnvIpc } from './env'
import { registerExportIpc } from './export'
import { registerFilesIpc } from './files'
import { registerDesktopFilesIpc } from './files-desktop'
import { registerGithubIpc } from './github'
import { registerGitIpc } from './git'
import { registerHistoryIpc } from './history'
import { registerElevenLabsIpc } from './elevenlabs'
import { registerInstructionsIpc } from './instructions'
import { registerIntegrationsIpc } from './integrations'
import { registerLinearIpc } from './linear'
import { registerLintIpc } from './lint'
import { registerProjectsIpc } from './projects'
import { registerSessionsIpc } from './sessions'
import { registerShellIpc } from './shell'
import { registerTerminalIpc } from './terminal'
import { registerWorkspacesIpc } from './workspaces'
import { workspacePlacement, type WorkspacePlacement } from '../workspace/placement'

export { setIpcRouter, setTrustedOrigin } from './handle'
export { handle, missingChannelHandlers, type IpcDeps } from './registry'

export function registerIpc(
  deps: IpcDeps,
  placement: WorkspacePlacement = workspacePlacement('worktree')
): void {
  handle('app:ping', () => 'pong')
  registerCloudIpc()

  handle('secrets:has', ({ provider }) => secretPresence(deps.secrets, provider))
  handle('secrets:set', ({ provider, value }) => deps.secrets.set(provider, value))
  handle('secrets:delete', ({ provider }) => deps.secrets.delete(provider))

  handle('providers:status', async (): Promise<Record<BackendId, AuthStatus>> => {
    const settled = await Promise.allSettled(
      BACKEND_IDS.map(async (backendId) => {
        return [backendId, await authStatusFor(backendId)] as const
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
  registerWorkspacesIpc(deps, placement)
  registerGitIpc(deps)
  registerGithubIpc(deps)
  registerIntegrationsIpc(deps)
  registerLinearIpc(deps)
  registerEnvIpc(deps)
  registerFilesIpc(deps)
  registerDesktopFilesIpc(deps)
  registerLintIpc(deps)
  registerTerminalIpc(deps)
  registerHistoryIpc(deps)
  registerExportIpc(deps)
  registerSessionsIpc(deps)
  registerCommentsIpc(deps)
  registerElevenLabsIpc(deps)
  registerInstructionsIpc(deps)
  registerShellIpc()
}
