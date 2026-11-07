import type { LinearIssueListResult, SecretPresence } from '../../shared/ipc-contract'
import { LinearAuthError, LINEAR_KEY_HINT } from '../integrations/linear/client'
import { listAssignedIssues } from '../integrations/linear/issues'
import { handle, maskSecret, type IpcDeps } from './index'

export function registerLinearIpc(deps: IpcDeps): void {
  handle('linear:hasKey', async (): Promise<SecretPresence> => {
    const value = await deps.secrets.get('linear')
    return value === null ? { present: false, masked: null } : { present: true, masked: maskSecret(value) }
  })

  handle('linear:setKey', ({ value }) => deps.secrets.set('linear', value))
  handle('linear:deleteKey', () => deps.secrets.delete('linear'))

  handle('linear:issues', async ({ query }): Promise<LinearIssueListResult> => {
    const apiKey = await deps.secrets.get('linear')
    if (apiKey === null) return { kind: 'needs-key', hint: LINEAR_KEY_HINT }
    try {
      return { kind: 'ok', issues: await listAssignedIssues(apiKey, query) }
    } catch (err) {
      // A rejected key is actionable in Settings; anything else is only reportable.
      if (err instanceof LinearAuthError) return { kind: 'invalid-key', hint: LINEAR_KEY_HINT }
      return { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
    }
  })
}
