import { readInstructions, writeInstructions } from '../instructions/files'
import { handle, type IpcDeps } from './index'

export function registerInstructionsIpc(deps: IpcDeps): void {
  handle('instructions:get', ({ scope, projectId }) => readInstructions(deps.dataRoot, scope, projectId))
  handle('instructions:set', ({ scope, projectId, text }) =>
    writeInstructions(deps.dataRoot, scope, projectId, text)
  )
}
