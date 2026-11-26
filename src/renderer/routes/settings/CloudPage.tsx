import { useEffect, useRef, useState } from 'react'
import type { CloudRunner } from '../../../shared/ipc-contract'
import type { CloudSignInMode } from '../../../shared/managed-cloud'
import { cloudStatusLabel, cloudTone } from '../../components/sidebar/CloudStatusDot'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
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
  const [workEmail, setWorkEmail] = useState('')
  const [mode, setMode] = useState<CloudSignInMode>('company')
  const [inBrowser, setInBrowser] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [invite, setInvite] = useState<{ host: string; code: string } | null>(null)
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
        setMode(current.mode ?? 'company')
      })
      .catch((err: unknown) => push(`Could not load the cloud settings: ${String(err)}`, 'err'))
    return () => {
      live = false
    }
  }, [push])

  function save() {
    setInBrowser(address.trim() !== '')
    window.loom.cloud
      .setRunner(address.trim() === '' ? null : address, workEmail, mode)
      .then((kept) => {
        setRunner(kept)
        setAddress(kept.url ?? '')
        setMode(kept.mode ?? 'company')
        push(kept.url === null ? 'Cloud turned off' : 'Connected to verified runner')
        if (kept.url !== null) navigate({ name: 'settings', page: 'org-overview' })
      })
      .catch((err: unknown) => push(`Could not save the runner address: ${String(err)}`, 'err'))
      .finally(() => setInBrowser(false))
  }

  function signIn() {
    const attempt = ++attempts.current
    setInBrowser(true)
    const signingIn =
      mode !== (runner?.mode ?? 'company')
        ? window.loom.cloud.setRunner(address, workEmail, mode)
        : window.loom.cloud.signIn(workEmail)
    signingIn
      .then((kept) => {
        if (kept) {
          setRunner(kept)
          setAddress(kept.url ?? '')
          setMode(kept.mode ?? 'company')
        }
        navigate({ name: 'settings', page: 'org-overview' })
      })
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
        <Field label="Cloud hosting">
          <select
            className="input"
            value={mode}
            disabled={inBrowser || runner?.fixed}
            onChange={(event) => {
              const selected = event.target.value as CloudSignInMode
              setMode(selected)
              if (selected === 'managed' && address.trim() === '') setAddress('wss://pilot.loombox.xyz')
            }}
          >
            <option value="company">Company runner</option>
            <option value="managed">Loom personal cloud</option>
          </select>
        </Field>
        <Field
          label="Your Google email"
          hint={
            mode === 'managed'
              ? 'Use the Gmail or Google Workspace account that owns this organization or received its invitation.'
              : 'Enter your primary Google Workspace email. Loom checks it against Google’s signed reply.'
          }
        >
          <input
            className="input"
            type="email"
            value={workEmail}
            maxLength={254}
            autoComplete="email"
            disabled={inBrowser}
            onChange={(event) => setWorkEmail(event.target.value)}
          />
        </Field>
      </section>
      <section className="settings-section">
        <div className="settings-label">Join an organization</div>
        <Field
          label="Invite code"
          hint="Paste the code from your organization’s owner. You’ll review its host before connecting."
        >
          <textarea
            className="input"
            rows={3}
            value={inviteCode}
            maxLength={4096}
            spellCheck={false}
            autoComplete="off"
            disabled={inBrowser || runner?.fixed}
            onChange={(event) => setInviteCode(event.target.value)}
          />
        </Field>
        <div>
          <button
            className="btn"
            disabled={inBrowser || runner === null || runner.fixed || inviteCode.trim() === ''}
            onClick={() => {
              const code = inviteCode.trim()
              void window.loom.cloud
                .previewInvite(code)
                .then((preview) => setInvite({ ...preview, code }))
                .catch((err: unknown) => push(String(err), 'err'))
            }}
          >
            Review invite
          </button>
        </div>
      </section>
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
        {inBrowser && (
          <p className="settings-note" role="status">
            Finish signing in in your browser. Loom connects as soon as you are done.
          </p>
        )}
        <Field
          label="Runner address"
          hint={
            runner?.fixed
              ? 'Set by LOOM_RUNNER_URL for this run.'
              : mode === 'managed'
                ? 'Use the Loom runner assigned to you, such as wss://pilot.loombox.xyz. Saving opens Google sign-in. Leave blank to turn cloud off.'
                : 'For operators: wss://loom.example.com. Saving a new address opens Google sign-in and verifies the host. Leave blank to turn cloud off.'
          }
        >
          <input
            className="input"
            value={address}
            maxLength={2048}
            spellCheck={false}
            autoComplete="off"
            disabled={runner === null || runner.fixed || inBrowser}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
        </Field>
        <div>
          <button className="btn" disabled={runner === null || runner.fixed || inBrowser} onClick={save}>
            {address.trim() === '' ? 'Turn cloud off' : 'Save and sign in'}
          </button>
        </div>
        <p className="settings-note">
          {runner?.devToken
            ? 'This run uses a developer token from LOOM_RUNNER_TOKEN, so there is nothing to sign in to.'
            : 'You sign in with Google in your browser. Loom keeps the sign-in in the macOS Keychain, one per runner; it is sent only to the runner that gave it. Your agents’ own logins stay on the runner.'}
        </p>
        {status.state === 'update' && runner?.url && (
          <p className="settings-note" role="status">
            {status.message}{' '}
            <button
              className="btn"
              onClick={() =>
                void window.loom.shell
                  .openExternal(`${runner.url!.replace(/^ws/, 'http').replace(/\/$/, '')}/download`)
                  .catch((err: unknown) => push(String(err), 'err'))
              }
            >
              Download matching Loom
            </button>
          </p>
        )}
      </section>
      <Modal
        open={invite !== null}
        title="Join organization"
        onClose={() => setInvite(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setInvite(null)}>
              Cancel
            </button>
            <button
              className="btn"
              disabled={inBrowser}
              onClick={() => {
                if (invite === null) return
                const code = invite.code
                setInvite(null)
                setInBrowser(true)
                void window.loom.cloud
                  .join(code, workEmail)
                  .then((kept) => {
                    setRunner(kept)
                    setAddress(kept.url ?? '')
                    setMode(kept.mode ?? 'company')
                    setInviteCode('')
                    navigate({ name: 'settings', page: 'org-overview' })
                  })
                  .catch((err: unknown) => push(`Could not join: ${String(err)}`, 'err'))
                  .finally(() => setInBrowser(false))
              }}
            >
              Continue with Google
            </button>
          </>
        }
      >
        <p>This invite connects to:</p>
        <p className="mono">{invite?.host}</p>
        <p>
          Loom will contact this host for Google sign-in, then verify that your company authorizes it. Your
          current runner stays connected until verification succeeds.
        </p>
      </Modal>
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
