import { useCallback, useEffect, useRef, useState } from 'react'
import type { CloudRunner } from '../../../shared/ipc-contract'
import { CloudIcon, MoreIcon } from '../../components/ui/icons'
import { Popover } from '../../components/ui/Popover'
import { useCloud } from '../../state/cloud'
import { useOrganization } from '../../state/organization'
import { useUi } from '../../state/ui'
import { CloudConnections } from './CloudConnections'
import { CloudSetupDialog, GoogleSignInLabel, type CloudDialog } from './CloudSetupDialog'
import './cloud.css'

/** Connection states have their own screens; account history never establishes access. */
export function CloudPage() {
  const status = useCloud((state) => state.status)
  const overview = useOrganization((state) => state.overview)
  const organizationError = useOrganization((state) => state.error)
  const organizationLoading = useOrganization((state) => state.loading)
  const [runner, setRunner] = useState<CloudRunner | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [dialog, setDialog] = useState<CloudDialog | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLButtonElement>(null)
  const generation = useRef(0)
  const lastOperation = useRef<(() => Promise<unknown>) | null>(null)
  const loadGeneration = useRef(0)
  const closeDialog = useCallback(() => setDialog(null), [])
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  const refresh = useCallback(async () => {
    const asked = ++loadGeneration.current
    try {
      const next = await window.loom.cloud.runner()
      if (asked === loadGeneration.current) {
        setRunner(next)
        setLoadError(null)
      }
    } catch {
      if (asked === loadGeneration.current) setLoadError('Could not load cloud settings.')
    }
  }, [])
  useEffect(() => {
    void refresh()
    return () => {
      loadGeneration.current++
    }
  }, [refresh, status.state, overview?.organization.name])
  useEffect(
    () => () => {
      generation.current++
    },
    []
  )

  async function signIn(operation: () => Promise<unknown>) {
    const asked = ++generation.current
    lastOperation.current = operation
    setPending(true)
    setError(null)
    try {
      await operation()
      if (asked === generation.current) await refresh()
    } catch (cause) {
      if (asked === generation.current) setError(String(cause).replace(/^Error: /, ''))
    } finally {
      if (asked === generation.current) {
        setPending(false)
        lastOperation.current = null
      }
    }
  }
  async function cancelSignIn() {
    generation.current++
    lastOperation.current = null
    setPending(false)
    try {
      await window.loom.cloud.cancelSignIn()
    } catch {
      setError('Could not cancel sign-in. Try again.')
    }
  }
  async function signOut() {
    if (signingOut) return
    generation.current++
    lastOperation.current = null
    setPending(false)
    setSigningOut(true)
    setError(null)
    try {
      await window.loom.cloud.signOut()
      await refresh()
    } catch {
      setError('Could not sign out. Try again.')
    } finally {
      setSigningOut(false)
    }
  }
  function returnSignIn() {
    if (!runner?.lastSignIn?.email) setDialog('sign-in')
    else void signIn(() => window.loom.cloud.signIn())
  }
  async function disconnect() {
    setError(null)
    try {
      await window.loom.cloud.setRunner(null)
      await refresh()
    } catch {
      setError('Could not disconnect this Mac. Try again.')
    }
  }
  function showDialog(kind: CloudDialog) {
    closeMenu()
    setError(null)
    setDialog(kind)
  }

  if (runner === null)
    return (
      <div className="cloud-page">
        <p role={loadError ? 'alert' : 'status'}>
          {loadError ?? 'Loading cloud settings…'}
          {loadError && (
            <button className="btn btn-ghost" onClick={() => void refresh()}>
              Retry
            </button>
          )}
        </p>
      </div>
    )

  const connected = status.state === 'connected'
  const configured = runner.url !== null
  const name = overview?.organization.name || runner.lastSignIn?.organizationName || 'Your cloud'
  const managed = runner.mode === 'managed'
  const historyEmail = runner.lastSignIn?.email
  const disk = overview?.health?.disk
  const owner = connected && overview?.role === 'owner'
  const canChange = !runner.fixed && !pending
  const showSignOut =
    configured && !runner.devToken && status.state !== 'signed-out' && status.state !== 'off'
  const storageUsed =
    disk && disk.total > 0 ? Math.min(100, Math.max(0, (1 - disk.available / disk.total) * 100)) : 0

  return (
    <div className="cloud-page">
      <div className="cloud-page-body">
        {loadError && (
          <p className="connection-error" role="alert">
            {loadError}
          </p>
        )}
        {error && (
          <p className="cloud-page-error" role="alert">
            {error}
          </p>
        )}
        {pending && connected && (
          <div className="cloud-sign-in-wait" role="status">
            <span className="cloud-wait-spinner" aria-hidden="true" />
            <div className="grow">
              <strong>Finish signing in</strong>
              <p>Continue in your browser. Loom connects when you finish.</p>
            </div>
          </div>
        )}
        {connected ? (
          <>
            <section className="cloud-overview-heading">
              <div className="cloud-org-heading">
                <span className="cloud-org-mark">
                  <CloudIcon />
                </span>
                <div>
                  <h2>{name}</h2>
                  <p>
                    {overview
                      ? `${managed ? 'Personal organisation' : 'Organisation'} · ${overview.role === 'owner' ? 'Owner' : 'Member'}`
                      : organizationLoading
                        ? 'Loading organisation…'
                        : 'Organisation details unavailable'}
                  </p>
                </div>
              </div>
              <div className="cloud-overview-actions">
                <span className="cloud-connection-state" data-connected>
                  <span className="settings-dot" data-tone="ok" />
                  Connected
                </span>
                {(owner || canChange) && (
                  <div className="popover-wrap">
                    <button
                      className="icon-btn"
                      ref={menuRef}
                      aria-label="Organisation options"
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      onClick={() => setMenuOpen((open) => !open)}
                    >
                      <MoreIcon />
                    </button>
                    <Popover open={menuOpen} onClose={closeMenu} anchorRef={menuRef} align="right">
                      {canChange && (
                        <button
                          className="list-option popover-item"
                          role="menuitem"
                          onClick={() => showDialog('invite')}
                        >
                          Join another organisation
                        </button>
                      )}
                      {owner && (
                        <button
                          className="list-option popover-item"
                          role="menuitem"
                          onClick={() => showDialog('rename')}
                        >
                          Rename organisation
                        </button>
                      )}
                    </Popover>
                  </div>
                )}
                <button
                  className="btn btn-primary"
                  onClick={() => useUi.getState().openAddWorkspace(null, 'cloud')}
                >
                  Create workspace <span aria-hidden="true">→</span>
                </button>
              </div>
            </section>
            {organizationError && (
              <p className="cloud-page-error" role="alert">
                Could not load organisation details.
                <button className="btn btn-ghost" onClick={() => void useOrganization.getState().refresh()}>
                  Retry
                </button>
              </p>
            )}
            <section className="cloud-machine-section" aria-labelledby="cloud-machine-title">
              <h3 id="cloud-machine-title">Cloud machine</h3>
              <div className="cloud-machine-card">
                <div className="cloud-machine-heading">
                  <CloudIcon />
                  <div className="grow">
                    <strong>{managed ? 'Hosted by Loom' : 'Hosted by your organisation'}</strong>
                    <p>Your cloud workspaces run here.</p>
                  </div>
                  <span className="cloud-machine-status">{disk?.warning ? 'Storage low' : 'Connected'}</span>
                </div>
                {disk && (
                  <div className="cloud-storage" data-warning={disk.warning}>
                    <div>
                      <span>Storage</span>
                      <span>
                        {(disk.available / 1024 ** 3).toFixed(1)} GB free of{' '}
                        {(disk.total / 1024 ** 3).toFixed(1)} GB
                      </span>
                    </div>
                    <div
                      className="cloud-storage-track"
                      role="meter"
                      aria-label="Cloud storage used"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(storageUsed)}
                    >
                      <span style={{ width: `${storageUsed}%` }} />
                    </div>
                  </div>
                )}
              </div>
            </section>
            <section className="cloud-connections-section" aria-labelledby="cloud-connections-title">
              <h3 id="cloud-connections-title">Connections</h3>
              <p>Accounts used by workspaces on this machine.</p>
              <CloudConnections providers={['github', 'claude', 'codex']} overview />
            </section>
          </>
        ) : !configured && !pending ? (
          <section className="cloud-welcome">
            <span className="cloud-welcome-mark">
              <CloudIcon />
            </span>
            <h2>Connect your cloud</h2>
            <p>
              Run your workspaces on a cloud machine.
              <br />
              Keep your code, terminals, and agents together.
            </p>
            <button className="btn btn-primary" onClick={() => showDialog('managed')}>
              Connect your Loom cloud <span aria-hidden="true">→</span>
            </button>
            <ul>
              <li>Your work stays on your cloud machine</li>
              <li>Reconnect whenever you open Loom</li>
            </ul>
            <p className="cloud-invitation-link">
              Have an invitation?{' '}
              <button className="btn btn-ghost" onClick={() => showDialog('invite')}>
                Join an organisation <span aria-hidden="true">→</span>
              </button>
            </p>
          </section>
        ) : (
          <section className="cloud-returning">
            <span className="cloud-welcome-mark">
              <CloudIcon />
            </span>
            <h2>
              {pending
                ? 'Finish signing in'
                : status.state === 'signed-out'
                  ? 'Sign in to your cloud'
                  : status.state === 'unreachable'
                    ? 'Your cloud is unavailable'
                    : status.state === 'update'
                      ? 'Cloud update required'
                      : 'Connecting to your cloud'}
            </h2>
            <p>
              {pending
                ? 'Continue in your browser. Loom reconnects when you finish.'
                : status.state === 'signed-out'
                  ? 'This Mac is signed out. Sign in with Google to access your organisation and cloud workspaces.'
                  : status.state === 'unreachable'
                    ? 'Your saved cloud machine could not be reached. Your connection is saved; retry when it is available.'
                    : status.state === 'update'
                      ? status.message
                      : 'Reconnecting to your saved cloud machine…'}
            </p>
            {pending && (
              <div className="cloud-pending-actions">
                <span className="cloud-wait-spinner" aria-hidden="true" />
                <span role="status">Waiting for Google approval…</span>
              </div>
            )}
            {configured && (
              <div className="cloud-saved-target">
                <CloudIcon />
                <div className="grow">
                  <strong>{name}</strong>
                  <p>{managed ? 'Loom cloud machine' : 'Organisation cloud machine'}</p>
                </div>
                <span>Saved connection</span>
              </div>
            )}
          </section>
        )}
        {configured && !pending && (
          <details className="cloud-advanced">
            <summary>Advanced</summary>
            <dl>
              <div>
                <dt>Connection address</dt>
                <dd>{runner.url}</dd>
              </div>
              <div>
                <dt>Hosting</dt>
                <dd>{managed ? 'Loom managed' : 'Self-hosted'}</dd>
              </div>
              {owner && overview?.settings && (
                <div>
                  <dt>Google client ID</dt>
                  <dd>{overview.settings.googleClientId}</dd>
                </div>
              )}
            </dl>
            {runner.fixed ? (
              <p>This connection is configured for this run.</p>
            ) : (
              <>
                <div className="cloud-advanced-actions">
                  <button
                    className="btn btn-ghost"
                    onClick={() => showDialog(managed ? 'managed' : 'company')}
                  >
                    Change connection
                  </button>
                  <button className="btn btn-ghost" disabled={signingOut} onClick={() => void disconnect()}>
                    Disconnect this Mac
                  </button>
                </div>
                <p>Disconnecting this Mac leaves cloud work running.</p>
              </>
            )}
          </details>
        )}
      </div>
      <footer
        className={`cloud-account-footer${status.state === 'signed-out' && !pending ? ' cloud-account-signed-out' : ''}`}
      >
        {pending ? (
          <>
            <div>
              <p>Waiting for browser sign-in</p>
              {historyEmail && <small>Last signed in as {historyEmail}</small>}
            </div>
            <div className="cloud-account-actions">
              <button className="btn btn-ghost" onClick={() => void cancelSignIn()}>
                Cancel
              </button>
              <button
                className="btn"
                onClick={() => lastOperation.current && void signIn(lastOperation.current)}
              >
                Open browser again
              </button>
            </div>
          </>
        ) : !configured ? (
          <>
            <small>Local workspaces stay on this Mac.</small>
            <button className="btn btn-ghost" disabled={runner.fixed} onClick={() => showDialog('company')}>
              Connect a self-hosted machine <span aria-hidden="true">›</span>
            </button>
          </>
        ) : status.state === 'signed-out' && !runner.devToken ? (
          <>
            <button className="btn btn-primary" onClick={returnSignIn}>
              <GoogleSignInLabel />
            </button>
            {historyEmail && <small>Last signed in as {historyEmail}</small>}
          </>
        ) : (
          <>
            <div>
              {historyEmail && !runner.devToken && <p>{historyEmail}</p>}
              <small>
                {runner.devToken
                  ? 'Developer connection'
                  : connected
                    ? 'Signed in with Google'
                    : 'Saved cloud connection'}
              </small>
            </div>
            <div className="cloud-account-actions">
              {status.state === 'unreachable' && (
                <button
                  className="btn"
                  onClick={() =>
                    void window.loom.cloud
                      .reconnect()
                      .catch(() => setError('Could not retry the connection.'))
                  }
                >
                  Retry connection
                </button>
              )}
              {status.state === 'update' && (
                <button
                  className="btn"
                  onClick={() =>
                    void window.loom.shell
                      .openExternal(`${runner.url!.replace(/^ws/, 'http').replace(/\/$/, '')}/download`)
                      .catch(() => setError('Could not open the download page.'))
                  }
                >
                  Download matching Loom
                </button>
              )}
              {showSignOut && (
                <button className="btn btn-ghost" disabled={signingOut} onClick={() => void signOut()}>
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              )}
            </div>
          </>
        )}
      </footer>
      {dialog && (
        <CloudSetupDialog
          key={dialog}
          kind={dialog}
          runner={runner}
          organizationName={name}
          onClose={closeDialog}
          onSignIn={(operation) => void signIn(operation)}
          onRenamed={() => useOrganization.getState().refresh()}
        />
      )}
    </div>
  )
}
