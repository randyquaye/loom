import { useEffect, useRef, useState } from 'react'
import { Field } from '../../components/ui/Field'
import { useToasts } from '../../components/ui/Toast'
import { useOrganization } from '../../state/organization'

/** Membership is visible to everyone; host configuration and usage belong to owners. */
export function OrgOverviewPage() {
  const overview = useOrganization((state) => state.overview)
  const connection = useOrganization((state) => state.connection)
  const push = useToasts((state) => state.push)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRef(0)

  useEffect(() => setName(overview?.organization.name ?? ''), [overview?.organization.name])
  useEffect(
    () => () => {
      request.current++
    },
    [connection]
  )

  if (overview === null) return null
  const owner = overview.role === 'owner'

  async function save() {
    const mine = ++request.current
    setBusy(true)
    try {
      await window.loom.org.update(name.trim())
    } catch (failure) {
      if (mine === request.current) push(String(failure), 'err')
    } finally {
      if (mine === request.current) {
        await useOrganization.getState().refresh()
        if (mine === request.current) setBusy(false)
      }
    }
  }

  return (
    <>
      <section className="settings-section">
        <div className="settings-label">Organization</div>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-provider">
              <span className="settings-name">{overview.organization.name || 'Name your organization'}</span>
              <span className="settings-state">Your role: {overview.role}</span>
            </div>
          </div>
        </div>
        {owner && (
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <Field label="Organization name">
              <input
                className="input"
                value={name}
                maxLength={100}
                required
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <button
              className="btn"
              disabled={busy || name.trim() === '' || name.trim() === overview.organization.name}
            >
              Save name
            </button>
          </form>
        )}
      </section>
      {owner && overview.settings !== undefined && (
        <section className="settings-section">
          <div className="settings-label">Google sign-in</div>
          <div className="settings-list">
            <div className="settings-row">
              <span className="settings-name">Allowed domains</span>
              <span className="settings-mask">{overview.settings.domains.join(', ')}</span>
            </div>
            <div className="settings-row">
              <span className="settings-name">Client ID</span>
              <span className="settings-mask">{overview.settings.googleClientId}</span>
            </div>
          </div>
          <p className="settings-note">Your operator manages these settings in AWS.</p>
        </section>
      )}
      {owner && overview.health !== undefined && (
        <section className="settings-section">
          <div className="settings-label">Host health</div>
          <p className="settings-note" role="status">
            {(overview.health.disk.available / 1024 ** 3).toFixed(1)} GB free of{' '}
            {(overview.health.disk.total / 1024 ** 3).toFixed(1)} GB.
            {overview.health.disk.warning && ' Disk space is low.'}
          </p>
          <div className="settings-list">
            {overview.usage?.map((person) => (
              <div className="settings-row" key={person.userId}>
                <span className="settings-name">{person.email}</span>
                <span className="settings-state">{person.running} running workspaces</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
