import { handle, type IpcDeps } from './registry'
import { sessionInstructions } from '../sessions/instructions'
import { markSessionRead, unreadSessions } from '../sessions/unread'
import {
  answerQuestion,
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
  steerTurn,
  steerQueued,
  sessionEvents,
  sessionEventsAfter,
  sessionActivity,
  sessionQueue
} from '../sessions/service'

export function registerSessionsIpc(deps: IpcDeps): void {
  handle('sessions:activity', () => sessionActivity())
  handle('sessions:unread', () => unreadSessions(deps.db))
  handle('sessions:markRead', ({ sessionId, seq }) => markSessionRead(deps.db, sessionId, seq))
  handle('sessions:list', ({ workspaceId }) => listSessions(deps.db, workspaceId))
  handle('sessions:create', (input) => createSession(deps.db, input))
  handle('sessions:send', ({ sessionId, text, attachments }) =>
    sendTurn(deps.db, sessionId, text, attachments, [deps.dataRoot])
  )
  handle('sessions:steer', ({ sessionId, text, attachments }) =>
    steerTurn(deps.db, sessionId, text, attachments, [deps.dataRoot])
  )
  handle('sessions:steerQueued', ({ sessionId, messageId }) => steerQueued(deps.db, sessionId, messageId))
  handle('sessions:answerQuestion', ({ sessionId, answer }) => answerQuestion(deps.db, sessionId, answer))
  handle('sessions:sendNow', ({ sessionId, text, attachments }) =>
    sendNow(deps.db, sessionId, text, attachments, [deps.dataRoot])
  )
  handle('sessions:cancel', ({ sessionId }) => cancelTurn(deps.db, sessionId))
  handle('sessions:events', ({ sessionId }) => sessionEvents(deps.db, sessionId))
  handle('sessions:eventsAfter', ({ sessionId, afterSeq }) =>
    sessionEventsAfter(deps.db, sessionId, afterSeq)
  )
  handle('sessions:instructions', ({ sessionId }) => sessionInstructions(deps.db, sessionId))
  handle('sessions:fork', (input) => forkSession(deps.db, input))
  handle('sessions:close', ({ sessionId }) => closeSessionRow(deps.db, sessionId))
  handle('sessions:closed', ({ workspaceId }) => closedSessions(deps.db, workspaceId))
  handle('sessions:reopen', ({ sessionId }) => reopenSession(deps.db, sessionId))
  handle('sessions:queue', ({ sessionId }) => sessionQueue(sessionId))
  handle('sessions:dequeue', ({ sessionId, index }) => dequeue(sessionId, index))
}
