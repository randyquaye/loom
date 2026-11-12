import { readInstructions, writeInstructions } from '../instructions/files'
import { saveProjectInstructions } from '../instructions/migrate-general'
import { handle, type IpcDeps } from './registry'

export function registerInstructionsIpc(deps: IpcDeps): void {
  handle('instructions:get', ({ scope, projectId }) => readInstructions(deps.dataRoot, scope, projectId))
  handle('instructions:set', ({ scope, projectId, text }) => {
    if (scope === 'project' && projectId !== null) {
      return saveProjectInstructions(deps.db, deps.dataRoot, projectId, text)
    }
    return writeInstructions(deps.dataRoot, scope, projectId, text)
  })
}
