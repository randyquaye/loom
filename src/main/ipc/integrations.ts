import type { GithubStatus, IntegrationsStatus, LinearStatus } from '../../shared/ipc-contract'
import { GH_AUTH_HINT, GH_INSTALL_HINT } from '../integrations/github/errors'
import { ghAuthState } from '../integrations/github/gh'
import { LINEAR_KEY_HINT } from '../integrations/linear/client'
import { elevenlabsStatus } from './elevenlabs'
import { handle, type IpcDeps } from './registry'

async function linearStatus(deps: IpcDeps): Promise<LinearStatus> {
  try {
    const key = await deps.secrets.get('linear')
    return key === null ? { state: 'needs-key', hint: LINEAR_KEY_HINT } : { state: 'ready' }
  } catch (err) {
    return { state: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

function githubStatus(installed: boolean, account: string | null): GithubStatus {
  if (!installed) return { state: 'not-installed', hint: GH_INSTALL_HINT }
  return account === null ? { state: 'not-authenticated', hint: GH_AUTH_HINT } : { state: 'ready', account }
}

/**
 * Aggregate integration health. Each half is probed independently so a missing `gh`
 * cannot mask the Linear key state, and neither probe can fail the whole call.
 */
export function registerIntegrationsIpc(deps: IpcDeps): void {
  handle('integrations:status', async (): Promise<IntegrationsStatus> => {
    const [auth, linear, elevenlabs] = await Promise.all([
      ghAuthState().catch(() => ({ installed: false, account: null })),
      linearStatus(deps),
      elevenlabsStatus(deps)
    ])
    return { github: githubStatus(auth.installed, auth.account), linear, elevenlabs }
  })
}
