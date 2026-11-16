import { UpdateControls, updateStatusText } from '../../components/updates/UpdateControls'
import { useDesktopUpdates } from '../../state/desktop-updates'

export function UpdatesPage() {
  const status = useDesktopUpdates((s) => s.status)
  const error = useDesktopUpdates((s) => s.error)
  return (
    <section className="settings-section">
      <div className="settings-row">
        <div className="settings-provider">
          <span className="settings-name">Loom</span>
          <span className="settings-state">
            {status === null ? 'Loading version…' : `Version ${status.currentVersion}`}
          </span>
        </div>
        <UpdateControls />
      </div>
      <p className="settings-note" role={status?.state === 'error' ? 'alert' : 'status'}>
        {updateStatusText(status)}
      </p>
      {status?.state === 'downloading' && (
        <progress className="update-progress" aria-label="Update download" value={status.percent} max={100} />
      )}
      {error !== null && (
        <p className="settings-note" role="alert">
          {error}
        </p>
      )}
      {status?.state === 'ready' && (
        <p className="settings-note">
          Restart when you’re ready. Loom will close and open again with the update.
        </p>
      )}
    </section>
  )
}
