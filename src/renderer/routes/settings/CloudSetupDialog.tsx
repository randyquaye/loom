import { useState, type FormEvent } from 'react'
import type { CloudRunner } from '../../../shared/ipc-contract'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'

export type CloudDialog = 'managed' | 'company' | 'sign-in' | 'invite' | 'rename'

export function GoogleSignInLabel() {
  return (
    <>
      <span className="cloud-google-mark" aria-hidden="true">
        G
      </span>
      Sign in with Google
    </>
  )
}

/** Setup fields exist only inside a deliberate connection or invitation step. */
export function CloudSetupDialog({
  kind,
  runner,
  organizationName,
  onClose,
  onSignIn,
  onRenamed
}: {
  kind: CloudDialog
  runner: CloudRunner
  organizationName: string
  onClose(): void
  onSignIn(operation: () => Promise<unknown>): void
  onRenamed(): Promise<void>
}) {
  const [email, setEmail] = useState(runner.lastSignIn?.email ?? '')
  const [address, setAddress] = useState(kind === (runner.mode ?? 'company') ? (runner.url ?? '') : '')
  const [name, setName] = useState(organizationName)
  const [code, setCode] = useState('')
  const [invite, setInvite] = useState<{ host: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title =
    kind === 'rename'
      ? 'Rename organisation'
      : kind === 'invite'
        ? invite === null
          ? 'Join another organisation'
          : 'Review organisation'
        : kind === 'sign-in'
          ? 'Sign in with Google'
          : kind === 'company'
            ? 'Connect a self-hosted machine'
            : 'Connect your Loom cloud'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError(null)
    if (kind === 'rename' || (kind === 'invite' && invite === null)) {
      setBusy(true)
      try {
        if (kind === 'rename') {
          await window.loom.org.update(name.trim())
          await onRenamed()
          onClose()
        } else setInvite(await window.loom.cloud.previewInvite(code.trim()))
      } catch (cause) {
        setError(String(cause).replace(/^Error: /, ''))
      } finally {
        setBusy(false)
      }
      return
    }
    const expectedEmail = email.trim()
    const operation =
      kind === 'sign-in'
        ? () => window.loom.cloud.signIn(expectedEmail)
        : kind === 'invite'
          ? () => window.loom.cloud.join(code.trim(), expectedEmail)
          : () => window.loom.cloud.setRunner(address.trim(), expectedEmail, kind)
    onSignIn(operation)
    onClose()
  }

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="cloud-setup-form" disabled={busy}>
            {busy ? (
              'Working…'
            ) : kind === 'rename' ? (
              'Save name'
            ) : kind === 'invite' && invite === null ? (
              'Review invitation'
            ) : (
              <GoogleSignInLabel />
            )}
          </button>
        </>
      }
    >
      <form id="cloud-setup-form" className="cloud-setup-form" onSubmit={submit}>
        {kind === 'rename' ? (
          <Field label="Organisation name">
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
            />
          </Field>
        ) : kind === 'invite' && invite === null ? (
          <>
            <p>Paste your invitation to review the organisation before connecting.</p>
            <Field label="Invitation code">
              <textarea
                className="input"
                rows={3}
                required
                value={code}
                maxLength={4096}
                spellCheck={false}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
            {runner.url !== null && (
              <p>Your current cloud stays connected until the new organisation is verified.</p>
            )}
          </>
        ) : (
          <>
            <p>
              {kind === 'sign-in'
                ? 'Confirm your Google email once. Loom will remember it on this Mac.'
                : invite !== null
                  ? 'Review this destination and use the Google account that received the invitation.'
                  : kind === 'company'
                    ? 'Use the address supplied by your organisation’s operator.'
                    : 'Connect the cloud machine already assigned to you.'}
            </p>
            {invite !== null && <p className="cloud-invite-host mono">{invite.host}</p>}
            <Field label={kind === 'company' ? 'Google Workspace email' : 'Google email'}>
              <input
                className="input"
                type="email"
                value={email}
                required
                maxLength={254}
                autoComplete="email"
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            {(kind === 'managed' || kind === 'company') && (
              <Field
                label="Machine address"
                hint={
                  kind === 'company'
                    ? 'Your operator provides this address.'
                    : 'Use the address provided when your Loom cloud was set up.'
                }
              >
                <input
                  className="input"
                  value={address}
                  required
                  maxLength={2048}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="wss://your-cloud-address"
                  onChange={(event) => setAddress(event.target.value)}
                />
              </Field>
            )}
            {invite !== null && <p>Your active cloud connection changes only after verification succeeds.</p>}
          </>
        )}
        {error !== null && (
          <p className="connection-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}
