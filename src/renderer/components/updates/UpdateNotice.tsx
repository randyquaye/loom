import { useDesktopUpdates } from '../../state/desktop-updates'
import { UpdateControls, updateStatusText } from './UpdateControls'
import '../notifications/notifications.css'

/** Available updates stay visible until the person downloads and chooses to restart. */
export function UpdateNotice() {
  const status = useDesktopUpdates((s) => s.status)
  const error = useDesktopUpdates((s) => s.error)
  const interacted = useDesktopUpdates((s) => s.interacted)
  if (status?.state === 'error' && !interacted) return null
  if (
    status?.state !== 'available' &&
    status?.state !== 'downloading' &&
    status?.state !== 'ready' &&
    status?.state !== 'error'
  )
    return null
  return (
    <section className="notification-card glass" aria-label="Loom update" aria-live="polite">
      <div className="notification-title">
        {status.state === 'error'
          ? 'Couldn’t update Loom'
          : status.state === 'ready'
            ? 'Update ready'
            : status.state === 'downloading'
              ? 'Downloading update'
              : 'Update available'}
      </div>
      <p className="notification-detail">{updateStatusText(status)}</p>
      {status.state === 'downloading' && (
        <progress className="update-progress" aria-label="Update download" value={status.percent} max={100} />
      )}
      {error !== null && (
        <p className="notification-detail" role="alert">
          {error}
        </p>
      )}
      <div className="notification-actions">
        <UpdateControls />
      </div>
    </section>
  )
}
