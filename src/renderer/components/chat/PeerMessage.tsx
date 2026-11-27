import type { SessionMessageOrigin } from '../../../shared/events'
import { useProjects } from '../../state/projects'
import { useSessions } from '../../state/sessions'
import { useUi } from '../../state/ui'
import { useToasts } from '../ui/Toast'
import { formatStamp } from './transcript'

export function PeerMessage({
  peer,
  text,
  at
}: {
  peer: SessionMessageOrigin
  text: string
  at: number | undefined
}) {
  const shortId = peer.sessionId.slice(0, 6)
  const title = peer.title || shortId

  async function openSource() {
    try {
      const available = () =>
        Object.values(useProjects.getState().workspacesByProject).some((rows) =>
          rows.some((workspace) => workspace.id === peer.workspaceId)
        )
      if (available()) {
        await useSessions.getState().load(peer.workspaceId)
        const sessions = useSessions.getState()
        if (
          available() &&
          sessions.sessionsByWorkspace[peer.workspaceId]?.some((session) => session.id === peer.sessionId)
        ) {
          sessions.setActive(peer.workspaceId, peer.sessionId)
          useUi.getState().setVoiceMode(false)
          useUi.getState().navigate({ name: 'workspace', workspaceId: peer.workspaceId })
          useUi.setState({ workspacePane: 'chat' })
          return
        }
      }
      useToasts.getState().push('Source session is closed or unavailable', 'err')
    } catch {
      useToasts.getState().push('Could not open source session', 'err')
    }
  }

  return (
    <details className="chat-peer" open>
      <summary>
        <svg className="icon chat-chevron" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m6 4 4 4-4 4" />
        </svg>
        <span>Interaction with session</span>
        <button
          type="button"
          className="chat-peer-source"
          aria-label={`Open session ${title}`}
          title={`Open session ${peer.sessionId}`}
          onClick={(event) => {
            event.preventDefault()
            void openSource()
          }}
        >
          <em>{title}</em>
        </button>
      </summary>
      <div className="chat-peer-content">
        <div className="chat-peer-meta">
          {at !== undefined && (
            <>
              <time dateTime={new Date(at).toISOString()}>{formatStamp(at)}</time>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="chat-peer-id" title={peer.sessionId}>
            {shortId}
          </span>
        </div>
        <div className="chat-peer-body">{peer.body ?? text}</div>
      </div>
    </details>
  )
}
