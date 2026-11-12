import type { IpcContract } from './ipc-contract'

export type SubjectKind = 'workspace' | 'session' | 'terminal' | 'comment'

/**
 * Which thing each call is about, and the input field that names it. The desktop reads it to
 * decide who answers a call, this Mac or the runner; the runner reads it to check that the
 * thing belongs to whoever is asking. A call that is not here is about no one thing.
 */
export const CALL_SUBJECTS: Partial<Record<keyof IpcContract, readonly [SubjectKind, string]>> = {
  'workspaces:remove': ['workspace', 'id'],
  'workspaces:setArchived': ['workspace', 'id'],
  'workspaces:scripts': ['workspace', 'workspaceId'],
  'workspaces:runAction': ['workspace', 'workspaceId'],
  'git:status': ['workspace', 'workspaceId'],
  'git:diff': ['workspace', 'workspaceId'],
  'git:checkpoints': ['workspace', 'workspaceId'],
  'git:saveCheckpoint': ['workspace', 'workspaceId'],
  'git:restoreCheckpoint': ['workspace', 'workspaceId'],
  'git:diffCheckpoint': ['workspace', 'workspaceId'],
  'github:workspacePr': ['workspace', 'workspaceId'],
  'sessions:list': ['workspace', 'workspaceId'],
  'sessions:create': ['workspace', 'workspaceId'],
  'sessions:fork': ['workspace', 'workspaceId'],
  'sessions:closed': ['workspace', 'workspaceId'],
  'comments:list': ['workspace', 'workspaceId'],
  'comments:add': ['workspace', 'workspaceId'],
  'files:tree': ['workspace', 'workspaceId'],
  'files:listDir': ['workspace', 'workspaceId'],
  'files:read': ['workspace', 'workspaceId'],
  'files:preview': ['workspace', 'workspaceId'],
  'files:reveal': ['workspace', 'workspaceId'],
  'lint:run': ['workspace', 'workspaceId'],
  'terminal:create': ['workspace', 'workspaceId'],
  'terminal:list': ['workspace', 'workspaceId'],
  'terminal:attach': ['workspace', 'workspaceId'],
  'sessions:markRead': ['session', 'sessionId'],
  'sessions:send': ['session', 'sessionId'],
  'sessions:steer': ['session', 'sessionId'],
  'sessions:steerQueued': ['session', 'sessionId'],
  'sessions:answerQuestion': ['session', 'sessionId'],
  'sessions:sendNow': ['session', 'sessionId'],
  'sessions:cancel': ['session', 'sessionId'],
  'sessions:events': ['session', 'sessionId'],
  'sessions:eventsAfter': ['session', 'sessionId'],
  'sessions:instructions': ['session', 'sessionId'],
  'sessions:exportMarkdown': ['session', 'sessionId'],
  'sessions:close': ['session', 'sessionId'],
  'sessions:reopen': ['session', 'sessionId'],
  'sessions:queue': ['session', 'sessionId'],
  'sessions:dequeue': ['session', 'sessionId'],
  'terminal:write': ['terminal', 'id'],
  'terminal:resize': ['terminal', 'id'],
  'terminal:destroy': ['terminal', 'id'],
  'terminal:setActive': ['terminal', 'id'],
  'comments:remove': ['comment', 'id']
}
