import { useCallback, useEffect, useState } from 'react'
import { useProjects } from '../../state/projects'
import { useUi } from '../../state/ui'
import { CloudConnections } from './CloudConnections'
import { ConnectionLocation } from './ConnectionLocation'
import { LocalConnectModal } from './LocalConnectModal'

const STATES: Record<string, { text: string; tone: string; action: string }> = {
  ready: { text: 'Connected', tone: 'ok', action: 'Manage' },
  'not-installed': { text: 'Not installed', tone: 'idle', action: 'Install' },
  'needs-login': { text: 'Sign in required', tone: 'warn', action: 'Sign in' },
  error: { text: 'Could not check sign-in', tone: 'idle', action: 'Retry' }
}
const CHECKING = { text: 'Checking…', tone: 'idle', action: 'Checking…' }

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
            {(['claude', 'codex'] as const).map((id) => {
              const view = STATES[status[id] ?? ''] ?? CHECKING
              return (
                <div key={id} className="settings-row connection-row">
                  <span className="settings-dot" data-tone={view.tone} aria-hidden="true" />
                  <div className="settings-provider">
                    <span className="settings-name">{id === 'claude' ? 'Claude' : 'Codex'}</span>
                    <span className="settings-state">{view.text}</span>
                  </div>
                  <button
                    className="btn"
                    disabled={status[id] === undefined}
                    onClick={() => {
                      if (status[id] === 'error') void refresh()
                      else setProvider(id)
                    }}
                  >
                    {view.action}
                  </button>
                </div>
              )
            })}
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
