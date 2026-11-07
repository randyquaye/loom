import { deleteEnvVar, listEnvVars, setEnvVar } from '../env/vars'
import { handle, type IpcDeps } from './index'

/**
 * Environment variables are stored encrypted in the secret store; only names and masked
 * values ever cross this boundary. Values reach agents through the process environment.
 */
export function registerEnvIpc(_deps: IpcDeps): void {
  handle('env:list', ({ scope, projectId }) => listEnvVars(scope, projectId))
  handle('env:set', ({ scope, projectId, name, value }) => setEnvVar(scope, projectId, name, value))
  handle('env:delete', ({ scope, projectId, name }) => deleteEnvVar(scope, projectId, name))
}
