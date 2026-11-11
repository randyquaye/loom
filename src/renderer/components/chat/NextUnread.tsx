import { useProjects } from '../../state/projects'
import { useSessions } from '../../state/sessions'
import { useUi } from '../../state/ui'

export function NextUnread() {
  const workspaces = useProjects((s) => s.workspacesByProject)
  const workspaceIds = new Set(Object.values(workspaces).flatMap((rows) => rows.map((row) => row.id)))
  const nextId = useSessions(
    (s) =>
      Object.entries(s.unreadBySession)
        .filter(([, unread]) => unread.seq > 0 && workspaceIds.has(unread.workspaceId))
        .sort(([, a], [, b]) => b.eventId - a.eventId)[0]?.[0] ?? null
  )
  if (nextId === null) return null

  return (
    <button
      type="button"
      className="btn next-unread"
      title="Jump to the most recent unread session"
      onClick={() => {
        const sessions = useSessions.getState()
        const unread = sessions.unreadBySession[nextId]
        if (!unread?.seq) return
        sessions.setActive(unread.workspaceId, nextId)
        const ui = useUi.getState()
        ui.setVoiceMode(false)
        ui.navigate({ name: 'workspace', workspaceId: unread.workspaceId })
        useUi.setState({ workspacePane: 'chat' })
      }}
    >
      Next Unread
    </button>
  )
}
