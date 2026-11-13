import { useEffect, useRef, useState } from 'react'
import type { CloudRunner } from '../../../shared/ipc-contract'
import { cloudStatusLabel, cloudTone } from '../../components/sidebar/CloudStatusDot'
import { Field } from '../../components/ui/Field'
import { useToasts } from '../../components/ui/Toast'
import { useCloud } from '../../state/cloud'
import { useUi } from '../../state/ui'

/** Settings "Cloud": which runner this Loom follows, and the sign-in to it. */
export function CloudPage() {
  const push = useToasts((s) => s.push)
  const navigate = useUi((s) => s.navigate)
  const status = useCloud((s) => s.status)
  const [runner, setRunner] = useState<CloudRunner | null>(null)
  const [address, setAddress] = useState('')
  const [inBrowser, setInBrowser] = useState(false)
  /** Only the latest sign-in attempt reports back; an earlier one was abandoned on purpose. */
  const attempts = useRef(0)

  useEffect(() => {
    let live = true
    window.loom.cloud
      .runner()
      .then((current) => {
        if (!live) return
        setRunner(current)
        setAddress(current.url ?? '')
      })
      .catch((err: unknown) => push(`Could not load the cloud settings: ${String(err)}`, 'err'))
    return () => {
      live = false
    }
  }, [push])

  function save() {
    window.loom.cloud
      .setRunner(address.trim() === '' ? null : address)
      .then((kept) => {
        setRunner(kept)
        setAddress(kept.url ?? '')
        push(kept.url === null ? 'Cloud turned off' : 'Saved runner address')
      })
      .catch((err: unknown) => push(`Could not save the runner address: ${String(err)}`, 'err'))
  }

  function signIn() {
    const attempt = ++attempts.current
    setInBrowser(true)
    window.loom.cloud
      .signIn()
      .catch((err: unknown) => {
        if (attempt === attempts.current) push(`Could not sign in: ${String(err)}`, 'err')
      })
      .finally(() => {
        if (attempt === attempts.current) setInBrowser(false)
      })
  }

  function signOut() {
    window.loom.cloud.signOut().catch((err: unknown) => push(`Could not sign out: ${String(err)}`, 'err'))
  }

  const signsIn = runner !== null && runner.url !== null && !runner.devToken
  const signedOut = status.state === 'signed-out'

  return (
    <>
      <section className="settings-section">
        <div className="settings-label">Runner</div>
        <div className="settings-list">
          <div className="settings-row">
            <span className="settings-dot" data-tone={cloudTone(status)} aria-hidden="true" />
            <div className="settings-provider">
              <span className="settings-name">cloud</span>
              <span className="settings-state">
                {status.state === 'off' ? 'Not set up' : cloudStatusLabel(status)}
              </span>
            </div>
            <span className="settings-mask">{runner?.url ?? 'no runner'}</span>
            {signsIn && signedOut && (
              <button className="btn" onClick={signIn}>
                {inBrowser ? 'Open sign-in again' : 'Sign in with Google'}
              </button>
            )}
            {signsIn && !signedOut && status.state !== 'off' && (
              <button className="btn btn-ghost" onClick={signOut}>
                Sign out
              </button>
            )}
          </div>
        </div>
        {inBrowser && signedOut && (
          <p className="settings-note" role="status">
            Finish signing in in your browser. Loom connects as soon as you are done.
          </p>
        )}
        <Field
          label="Runner address"
          hint={
            runner?.fixed
              ? 'Set by LOOM_RUNNER_URL for this run.'
              : 'Such as wss://loom.example.com. Leave blank to keep Loom on this Mac only.'
          }
        >
          <input
            className="input"
            value={address}
            maxLength={2048}
            spellCheck={false}
            autoComplete="off"
            disabled={runner === null || runner.fixed}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
        </Field>
        <div>
          <button className="btn" disabled={runner === null || runner.fixed} onClick={save}>
            Save address
          </button>
        </div>
        <p className="settings-note">
          {runner?.devToken
            ? 'This run uses a developer token from LOOM_RUNNER_TOKEN, so there is nothing to sign in to.'
            : 'You sign in with your company Google account, in your browser. Loom keeps the sign-in in the macOS Keychain, one per runner; it is sent only to the runner that gave it. Your agents’ own logins stay on the runner.'}
        </p>
      </section>
      <section className="settings-section">
        <p className="settings-note">Set up your cloud logins in Agents and Integrations.</p>
        <div className="connection-actions">
          <button
            className="btn"
            onClick={() => {
              useUi.getState().setSettingsLocation('cloud')
              navigate({ name: 'settings', page: 'agents' })
            }}
          >
            Agents
          </button>
          <button
            className="btn"
            onClick={() => {
              useUi.getState().setSettingsLocation('cloud')
              navigate({ name: 'settings', page: 'integrations' })
            }}
          >
            Integrations
          </button>
        </div>
      </section>
    </>
  )
}
