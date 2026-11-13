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

/** The colour a connection state is drawn in, wherever it shows as a dot. */
export function cloudTone(status: CloudStatus): 'ok' | 'warn' | 'danger' | 'idle' {
  switch (status.state) {
    case 'connected':
      return 'ok'
    case 'signed-out':
    case 'unreachable':
      return 'warn'
    case 'update':
      return 'danger'
    case 'connecting':
    case 'off':
      return 'idle'
  }
}

/** How the connection to the runner is doing, as a dot. Renders nothing when Loom follows no runner. */
export function CloudStatusDot() {
  const status = useCloud((s) => s.status)
  if (status.state === 'off') return null
  const label = cloudStatusLabel(status)
  return (
    <span className="cloud-dot" data-tone={cloudTone(status)} role="img" aria-label={label} title={label} />
  )
}
