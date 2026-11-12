import type { CloudStatus } from '../../../shared/ipc-contract'
import { useCloud } from '../../state/cloud'

/** The connection in a few words; empty when Loom follows no runner. */
export function cloudStatusLabel(status: CloudStatus): string {
  switch (status.state) {
    case 'connected':
      return 'Cloud connected'
    case 'connecting':
      return 'Connecting to cloud…'
    case 'unreachable':
      return 'Cloud unreachable'
    case 'signed-out':
      return 'Signed out of cloud'
    case 'update':
      return status.message
    case 'off':
      return ''
  }
}

/** How the connection to the runner is doing. Renders nothing when Loom follows no runner. */
export function CloudStatusLine() {
  const status = useCloud((s) => s.status)
  if (status.state === 'off') return null
  return (
    <div className="cloud-status" data-state={status.state} role="status">
      <span className="cloud-status-dot" aria-hidden="true" />
      <span>{cloudStatusLabel(status)}</span>
    </div>
  )
}
