import { useCallback, useEffect, useState } from 'react'
import { useProjects } from '../../state/projects'
import { useUi } from '../../state/ui'
import { CloudConnections } from './CloudConnections'
import { ConnectionLocation } from './ConnectionLocation'
import { LocalConnectModal } from './LocalConnectModal'

export function AgentsPage() {
  const location = useUi((state) => state.settingsLocation)
  const status = useProjects((state) => state.statusByProvider)
  const [provider, setProvider] = useState<'claude' | 'codex' | null>(null)
  const close = useCallback(() => setProvider(null), [])
  const refresh = useCallback(() => useProjects.getState().load(), [])
  useEffect(() => {
    if (location !== 'mac') return
    void refresh()
    const focused = () => {
      void refresh()
    }
    window.addEventListener('focus', focused)
    return () => window.removeEventListener('focus', focused)
  }, [location, refresh])
  return (
    <>
      <ConnectionLocation />
      {location === 'cloud' ? (
        <CloudConnections providers={['claude', 'codex']} />
      ) : (
        <section className="settings-section">
          <div className="settings-list">
            {(['claude', 'codex'] as const).map((id) => (
              <div key={id} className="settings-row connection-row">
                <span
                  className="settings-dot"
                  data-tone={status[id] === 'error' ? 'danger' : 'idle'}
                  aria-hidden="true"
                />
                <div className="settings-provider">
                  <span className="settings-name">{id === 'claude' ? 'Claude' : 'Codex'}</span>
                  <span className="settings-state">
                    {status[id] === undefined
                      ? 'Checking…'
                      : status[id] === 'ready'
                        ? 'Installed · Uses your CLI login'
                        : status[id] === 'error'
                          ? 'Could not check installation'
                          : 'Not installed'}
                  </span>
                </div>
                <button className="btn" onClick={() => setProvider(id)}>
                  Connect
                </button>
              </div>
            ))}
          </div>
          <p className="settings-note">
            Local workspaces use the logins managed by Claude and Codex on this Mac.
          </p>
        </section>
      )}
      <LocalConnectModal provider={provider} onClose={close} onRefresh={refresh} />
    </>
  )
}
