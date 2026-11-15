import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentLogins, CodexSignIn } from '../../../shared/ipc-contract'
import { supportsSubscriptions } from '../../../shared/runner-capabilities'
import type { SubscriptionAccount, SubscriptionProvider } from '../../../shared/subscriptions'
import { Dropdown } from '../../components/ui/Dropdown'
import { Field } from '../../components/ui/Field'
import { useCloud } from '../../state/cloud'
import { useOrganization } from '../../state/organization'

const failure = (cause: unknown) => String(cause).replace(/^Error: /, '')
const PROVIDERS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' }
]
const STATES = {
  disconnected: 'Not connected',
  ready: 'Ready',
  rate_limited: 'Rate limited',
  auth_failed: 'Sign-in required'
}

export function SubscriptionsPage() {
  const status = useCloud((state) => state.status)
  const owner = useOrganization((state) => state.overview?.role === 'owner')
  const connection = useOrganization((state) => state.connection)
  const available = status.state === 'connected' && supportsSubscriptions(status.capabilities)
  const [accounts, setAccounts] = useState<SubscriptionAccount[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [provider, setProvider] = useState<SubscriptionProvider>('claude')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const listing = useRef(0)
  const submitting = useRef(false)
  const refresh = useCallback(async () => {
    const mine = generation.current
    const asked = ++listing.current
    try {
      const rows = await window.loom.subscriptions.list()
      if (mine !== generation.current || asked !== listing.current) return
      setAccounts(rows)
      setError(null)
      setLoading(false)
    } catch (cause) {
      if (mine === generation.current && asked === listing.current) {
        setError(failure(cause))
        setLoading(false)
      }
    }
  }, [])
  useEffect(() => {
    generation.current++
    setAccounts([])
    setSelectedId(null)
    setLabel('')
    setError(null)
    setLoading(owner && available)
    submitting.current = false
    setBusy(false)
    if (!owner || !available) return
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => {
      generation.current++
      clearInterval(timer)
    }
  }, [owner, available, connection, refresh])
  async function create() {
    if (submitting.current) return
    const mine = generation.current
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const account = await window.loom.subscriptions.create(provider, label.trim())
      if (mine !== generation.current) return
      setAccounts((rows) => [...rows.filter((row) => row.id !== account.id), account])
      setSelectedId(account.id)
      setLabel('')
      await refresh()
    } catch (cause) {
      if (mine === generation.current) setError(failure(cause))
    } finally {
      if (mine === generation.current) {
        submitting.current = false
        setBusy(false)
      }
    }
  }

  if (status.state !== 'connected')
    return (
      <p className="settings-note">
        Connect to your organization under Cloud settings to manage subscriptions.
      </p>
    )
  if (!owner) return <p className="settings-note">Only an organization owner can manage subscriptions.</p>
  if (!available)
    return <p className="settings-note">Ask your operator to update the runner to manage subscriptions.</p>
  const selected = accounts.find((account) => account.id === selectedId) ?? accounts[0]
  return (
    <>
      <section className="settings-section">
        <div className="row">
          <div className="settings-label grow">Organization subscription accounts</div>
          <button className="btn btn-ghost" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        <p className="settings-note">
          Claude and Codex each have an organization pool. Grant bots access to these pools in Bots settings.
          Connected accounts stay outside bot workspaces.
        </p>
        {loading && (
          <p className="settings-note" role="status">
            Loading accounts…
          </p>
        )}
        {!loading && accounts.length === 0 && <p className="settings-note">No subscription accounts yet.</p>}
        <div className="settings-list">
          {accounts.map((account) => (
            <div className="settings-row" key={account.id}>
              <button
                className="btn btn-ghost grow bot-choice"
                aria-pressed={selected?.id === account.id}
                onClick={() => setSelectedId(account.id)}
              >
                {account.label}
              </button>
              <span className="settings-state">
                {account.provider === 'claude' ? 'Claude' : 'Codex'} ·{' '}
                {account.enabled ? STATES[account.state] : 'Disabled'}
              </span>
            </div>
          ))}
        </div>
        {error && (
          <p className="connection-error" role="alert">
            {error}
          </p>
        )}
      </section>
      {selected && (
        <SubscriptionDetails key={`${connection}:${selected.id}`} account={selected} onChanged={refresh} />
      )}
      <section className="settings-section">
        <div className="settings-label">Add subscription account</div>
        <form
          className="settings-form bot-form"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <fieldset disabled={busy}>
            <Field label="Provider">
              <Dropdown
                value={provider}
                options={PROVIDERS}
                onChange={(value) => setProvider(value as SubscriptionProvider)}
              />
            </Field>
            <Field label="Account label" hint="A name your organization can recognize.">
              <input
                className="input"
                value={label}
                maxLength={100}
                required
                onChange={(event) => setLabel(event.target.value)}
              />
            </Field>
            <button className="btn" disabled={label.trim() === ''}>
              {busy ? 'Adding…' : 'Add account'}
            </button>
          </fieldset>
        </form>
      </section>
    </>
  )
}

function SubscriptionDetails({
  account,
  onChanged
}: {
  account: SubscriptionAccount
  onChanged(): Promise<void>
}) {
  const [label, setLabel] = useState(account.label)
  const [availability, setAvailability] = useState({
    enabled: account.enabled,
    expectedEnabled: account.enabled
  })
  useEffect(() => {
    setAvailability({ enabled: account.enabled, expectedEnabled: account.enabled })
  }, [account.enabled])
  const [token, setToken] = useState('')
  const [logins, setLogins] = useState<AgentLogins | null>(null)
  const [device, setDevice] = useState<CodexSignIn | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const listing = useRef(0)
  const submitting = useRef(false)
  const refresh = useCallback(async () => {
    const mine = generation.current
    const asked = ++listing.current
    try {
      const next = await window.loom.subscriptions.status(account.id)
      if (mine !== generation.current || asked !== listing.current) return
      setLogins(next)
      if (next.codex || ['failed', 'expired'].includes(next.attempts?.codex?.state ?? '')) setDevice(null)
    } catch (cause) {
      if (mine === generation.current && asked === listing.current) setError(failure(cause))
    }
  }, [account.id])
  useEffect(() => {
    generation.current++
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => {
      generation.current++
      clearInterval(timer)
    }
  }, [refresh])
  async function act(operation: () => Promise<unknown>, success?: (value: unknown) => void) {
    if (submitting.current) return
    const mine = generation.current
    submitting.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await operation()
      if (mine !== generation.current) return
      success?.(result)
      await Promise.all([refresh(), onChanged()])
    } catch (cause) {
      if (mine === generation.current) setError(failure(cause))
    } finally {
      if (mine === generation.current) {
        submitting.current = false
        setBusy(false)
      }
    }
  }
  const waiting = logins?.attempts?.codex
  const signIn =
    device ??
    (waiting?.state === 'waiting' && waiting.url && waiting.code
      ? { url: waiting.url, code: waiting.code }
      : null)
  return (
    <section className="settings-section">
      <div className="settings-label">{account.label}</div>
      <p className="settings-note">
        {STATES[account.state]} · {account.assignedWorkspaces} assigned workspace
        {account.assignedWorkspaces === 1 ? '' : 's'}
        {account.lastUsedAt !== null && <> · Last used {new Date(account.lastUsedAt).toLocaleString()}</>}
      </p>
      {account.retryAt !== null && (
        <p className="settings-note">Retry after {new Date(account.retryAt).toLocaleString()}.</p>
      )}
      {account.providerResetAt !== null && account.providerResetAt > Date.now() && (
        <p className="settings-note">
          Provider reported reset: {new Date(account.providerResetAt).toLocaleString()}.
        </p>
      )}
      <form
        className="settings-form bot-form"
        onSubmit={(event) => {
          event.preventDefault()
          void act(() =>
            window.loom.subscriptions.update(
              account.id,
              label.trim(),
              availability.enabled,
              availability.expectedEnabled
            )
          )
        }}
      >
        <fieldset disabled={busy}>
          <Field label="Account label">
            <input
              className="input"
              value={label}
              maxLength={100}
              required
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <label className="row">
            <input
              className="preferences-toggle"
              type="checkbox"
              checked={availability.enabled}
              onChange={(event) => {
                const enabled = event.target.checked
                setAvailability((current) => ({ ...current, enabled }))
              }}
            />
            Available to granted bots
          </label>
          <p className="settings-note">
            Disabling or disconnecting an account stops affected bot work. Conversations retain their selected
            account.
          </p>
          <button className="btn" disabled={label.trim() === ''}>
            Save account
          </button>
        </fieldset>
      </form>
      {account.provider === 'claude' ? (
        <form
          className="settings-form bot-form"
          onSubmit={(event) => {
            event.preventDefault()
            const value = token
            setToken('')
            void act(() => window.loom.subscriptions.connectClaude(account.id, value))
          }}
        >
          <fieldset disabled={busy}>
            <Field
              label="Claude setup token"
              hint="Run claude setup-token using this organization subscription account."
            >
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                value={token}
                maxLength={8192}
                required
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>
            <button className="btn" disabled={token.trim() === ''}>
              Connect Claude
            </button>
          </fieldset>
        </form>
      ) : (
        <div className="settings-form subscription-sign-in">
          <button
            className="btn"
            disabled={busy || logins?.codexSigningIn}
            onClick={() =>
              void act(
                () => window.loom.subscriptions.connectCodex(account.id),
                (value) => setDevice(value as CodexSignIn)
              )
            }
          >
            {logins?.codexSigningIn ? 'Waiting for Codex sign-in…' : 'Connect Codex'}
          </button>
          {signIn && (
            <>
              <p className="settings-note">
                Sign in with this organization subscription account. Device code:{' '}
                <strong className="mono">{signIn.code}</strong>
              </p>
              <button
                className="btn btn-ghost"
                onClick={() => void window.loom.shell.openExternal(signIn.url)}
              >
                Open sign-in page
              </button>
            </>
          )}
          {waiting?.message && <p className="settings-note">{waiting.message}</p>}
        </div>
      )}
      <button
        className="btn btn-ghost"
        disabled={busy}
        onClick={() =>
          void act(
            () => window.loom.subscriptions.disconnect(account.id),
            () => setDevice(null)
          )
        }
      >
        Disconnect account
      </button>
      {error && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
