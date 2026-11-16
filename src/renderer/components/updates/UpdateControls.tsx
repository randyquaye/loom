import type { DesktopUpdateStatus } from '../../../shared/desktop-updates'
import { useDesktopUpdates } from '../../state/desktop-updates'

export function updateStatusText(status: DesktopUpdateStatus | null): string {
  if (status === null) return 'Loading update status…'
  switch (status.state) {
    case 'unavailable':
      return 'Updates aren’t available in this version of Loom.'
    case 'idle':
      return 'Loom checks for updates automatically. You choose when to download and restart.'
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Loom ${status.version} is available.`
    case 'downloading':
      return `Downloading Loom ${status.version}… ${Math.round(status.percent)}%`
    case 'ready':
      return `Loom ${status.version} is ready to install.`
    case 'error':
      return status.message
  }
}

/** The settings page and persistent notice offer the same explicit update actions. */
export function UpdateControls() {
  const status = useDesktopUpdates((s) => s.status)
  const pending = useDesktopUpdates((s) => s.pending)
  const error = useDesktopUpdates((s) => s.error)
  const run = useDesktopUpdates((s) => s.run)
  const disabled = pending !== null
  if (status?.state === 'available') {
    return (
      <button className="btn" disabled={disabled} onClick={() => void run('download')}>
        {pending === 'download' ? 'Starting download…' : error === null ? 'Download' : 'Retry download'}
      </button>
    )
  }
  if (status?.state === 'ready') {
    return (
      <button className="btn" disabled={disabled} onClick={() => void run('install')}>
        {pending === 'install' ? 'Restarting…' : 'Restart and install'}
      </button>
    )
  }
  const busy = status?.state === 'checking' || status?.state === 'downloading'
  return (
    <button
      className="btn"
      disabled={disabled || busy || status?.state === 'unavailable' || (status === null && error === null)}
      onClick={() => void run('check')}
    >
      {status?.state === 'downloading'
        ? 'Downloading…'
        : pending === 'check' || status?.state === 'checking'
          ? 'Checking…'
          : status?.state === 'error' || error !== null
            ? 'Try again'
            : 'Check for updates'}
    </button>
  )
}
