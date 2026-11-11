import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionInstructionsInfo } from '../../../shared/ipc-contract'
import { Modal } from '../ui/Modal'
import './session-instructions.css'

const STATUS_COPY = {
  saved:
    'These are the exact Loom instructions saved for this session. Later settings changes apply to new sessions.',
  pending: 'Instructions will be saved when you send this session’s first message.',
  legacy: 'This session’s original instructions were not recorded. They cannot be reconstructed here.'
}

export function SessionInstructions({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [info, setInfo] = useState<SessionInstructionsInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    window.loom.sessions.instructions(sessionId).then(
      (result) => {
        if (active) setInfo(result)
      },
      (reason: unknown) => {
        if (active) setError(`Could not load instructions: ${String(reason)}`)
      }
    )
    return () => {
      active = false
    }
  }, [sessionId])

  return createPortal(
    <Modal open title="Session instructions" className="session-instructions" width={720} onClose={onClose}>
      {error !== null ? (
        <p className="session-instructions-note" role="alert">
          {error}
        </p>
      ) : info === null ? (
        <p className="session-instructions-note" role="status">
          Loading instructions…
        </p>
      ) : (
        <>
          <p className="session-instructions-note">{STATUS_COPY[info.status]}</p>
          {info.text !== null && (
            <pre className="session-instructions-text" tabIndex={0} aria-label="Saved Loom instructions">
              {info.text}
            </pre>
          )}
          <p className="session-instructions-note">
            {info.repositoryMode === 'native'
              ? 'The agent manages repository instruction files and skills separately. This view does not verify which were loaded.'
              : 'Loom includes available root repository instruction files in saved instructions for this provider. Native skill and nested instruction loading are not provided by Loom.'}
          </p>
          <p className="session-instructions-note">
            General handbook and skills: the configurable GitHub source is reserved for a future integration
            and is not connected.
          </p>
        </>
      )}
    </Modal>,
    document.body
  )
}
