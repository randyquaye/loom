import { handle, type IpcDeps } from './index'
import {
  cancelTurn,
  closedSessions,
  closeSessionRow,
  createSession,
  dequeue,
  forkSession,
  listSessions,
  reopenSession,
  sendNow,
  sendTurn,
  sessionEvents,
  sessionQueue
} from '../sessions/service'

export function registerSessionsIpc(deps: IpcDeps): void {
  handle('sessions:list', ({ workspaceId }) => listSessions(deps.db, workspaceId))
  handle('sessions:create', (input) => createSession(deps.db, input))
  handle('sessions:send', ({ sessionId, text, attachments }) =>
    sendTurn(deps.db, sessionId, text, attachments, [deps.dataRoot])
  )
  handle('sessions:sendNow', ({ sessionId, text, attachments }) =>
    sendNow(deps.db, sessionId, text, attachments, [deps.dataRoot])
  )
  handle('sessions:cancel', ({ sessionId }) => cancelTurn(deps.db, sessionId))
  handle('sessions:events', ({ sessionId }) => sessionEvents(deps.db, sessionId))
  handle('sessions:fork', (input) => forkSession(deps.db, input))
  handle('sessions:close', ({ sessionId }) => closeSessionRow(deps.db, sessionId))
  handle('sessions:closed', ({ workspaceId }) => closedSessions(deps.db, workspaceId))
  handle('sessions:reopen', ({ sessionId }) => reopenSession(deps.db, sessionId))
  handle('sessions:queue', ({ sessionId }) => sessionQueue(sessionId))
  handle('sessions:dequeue', ({ sessionId, index }) => dequeue(sessionId, index))
}
