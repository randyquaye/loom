import { usePreferences } from '../state/preferences'
import { useSessions } from '../state/sessions'
import { useUi } from '../state/ui'

export function shouldPlayCompletionSound(sessionId: string): boolean {
  if (!usePreferences.getState().completionSoundEnabled) return false
  const { route, workspacePane } = useUi.getState()
  const foregroundSession =
    route.name === 'workspace' && workspacePane === 'chat'
      ? useSessions.getState().activeSessionByWorkspace[route.workspaceId]
      : null
  return !document.hasFocus() || document.visibilityState !== 'visible' || foregroundSession !== sessionId
}
