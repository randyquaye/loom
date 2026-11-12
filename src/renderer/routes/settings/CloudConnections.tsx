import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentLoginProvider, AgentLogins, CloudRunner, LoginAttempt } from '../../../shared/ipc-contract'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { useCloud } from '../../state/cloud'
import { useUi } from '../../state/ui'
import { CopyIcon } from '../../components/ui/icons'

const NAMES = { claude: 'Claude', codex: 'Codex', github: 'GitHub' }
const WAITING = new Set<LoginAttempt['state']>(['starting', 'waiting'])

function Copy({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    setCopied(false)
    setError(false)
  }, [text])
  return (
    <span className="connection-copy">
      <button
        type="button"
        className="icon-btn"
        aria-label={label}
        title={label}
        onClick={() => {
          void navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            .catch(() => setError(true))
        }}
      >
        <CopyIcon />
      </button>
      <span role="status">{copied ? 'Copied' : error ? 'Select to copy' : ''}</span>
    </span>
  )
}

export function CloudConnections({ providers }: { providers: readonly AgentLoginProvider[] }) {
  const state = useCloud((value) => value.status.state)
  const navigate = useUi((value) => value.navigate)
  const [runner, setRunner] = useState<CloudRunner | null>(null)
  const [logins, setLogins] = useState<AgentLogins | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [modal, setModal] = useState<'claude' | 'codex' | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState<AgentLoginProvider | null>(null)
  const generation = useRef(0)
  const submitting = useRef(false)
  const refresh = useCallback(async () => {
    const asked = generation.current
    try {
      const next = await window.loom.logins.status()
      if (asked === generation.current) {
        setLogins(next)
        setLoadError(null)
      }
    } catch {
      if (asked === generation.current) setLoadError('Could not check cloud logins.')
    }
  }, [])
  useEffect(() => {
    const asked = ++generation.current
    setLogins(null)
    setRunner(null)
    setLoadError(null)
    setError(null)
    setModal(null)
    setToken('')
    setBusy(null)
    submitting.current = false
    void window.loom.cloud
      .runner()
      .then((next) => {
        if (asked === generation.current) setRunner(next)
      })
      .catch(() => {
        if (asked === generation.current) setLoadError('Could not load the runner address.')
      })
    if (state !== 'connected')
      return () => {
        generation.current++
      }
    void refresh()
    const timer = setInterval(() => {
      void refresh()
    }, 3000)
    const onFocus = () => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      generation.current++
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [state, refresh])

  const close = useCallback(() => {
    setModal(null)
    setToken('')
    setError(null)
  }, [])
  const codex = logins?.attempts?.codex
  const completed = useRef<string | null>(null)
  useEffect(() => {
    if (codex?.state === 'connected' && completed.current !== codex.id) {
      completed.current = codex.id
      setModal((current) => (current === 'codex' ? null : current))
    }
  }, [codex])

  async function act(provider: AgentLoginProvider, action: () => Promise<unknown>, success?: () => void) {
    if (submitting.current) return
    const asked = generation.current
    submitting.current = true
    setBusy(provider)
    setError(null)
    try {
      await action()
      if (asked === generation.current) {
        success?.()
        await refresh()
      }
    } catch (cause) {
      if (asked === generation.current) setError(String(cause).replace(/^Error: /, ''))
    } finally {
      if (asked === generation.current) {
        setBusy(null)
        submitting.current = false
      }
    }
  }
  function connect(provider: AgentLoginProvider) {
    if (provider === 'claude') {
      setToken('')
      setError(null)
      setModal('claude')
      return
    }
    if (provider === 'codex') {
      setError(null)
      setModal('codex')
      if (codex !== undefined && WAITING.has(codex.state)) return
      void act(provider, () => window.loom.logins.connectCodex())
    } else {
      const asked = generation.current
      void act(provider, async () => {
        const { url } = await window.loom.logins.connectGithub()
        if (asked === generation.current) await window.loom.shell.openExternal(url)
      })
    }
  }
  const host = runner?.url === null || runner?.url === undefined ? null : new URL(runner.url).host
  const unavailable =
    state === 'off'
      ? 'Set up Cloud to connect cloud logins.'
      : state === 'signed-out'
        ? 'Sign in to Cloud first.'
        : state === 'unreachable'
          ? 'Cloud unavailable.'
          : state === 'update'
            ? 'Cloud update required.'
            : state === 'connecting'
              ? 'Connecting to cloud…'
              : logins?.managed === false
                ? 'Cloud login setup is unavailable on this runner.'
                : null

  return (
    <>
      <section className="settings-section">
        {host !== null && (
          <p className="settings-note">
            Your cloud workspaces on <strong>{host}</strong>
          </p>
        )}
        {unavailable !== null ? (
          <div className="connection-notice">
            <span role="status">{unavailable}</span>
            <button className="btn btn-ghost" onClick={() => navigate({ name: 'settings', page: 'cloud' })}>
              Cloud settings
            </button>
          </div>
        ) : (
          <>
            {loadError !== null && (
              <p role="alert" className="connection-error">
                {loadError}{' '}
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    void refresh()
                  }}
                >
                  Retry
                </button>
              </p>
            )}
            {logins === null ? (
              <p className="settings-note" role="status">
                Checking cloud logins…
              </p>
            ) : (
              <div className="settings-list">
                {providers.map((provider) => {
                  const attempt = provider === 'claude' ? undefined : logins.attempts?.[provider]
                  const waiting = attempt !== undefined && WAITING.has(attempt.state)
                  const configured = provider !== 'github' || logins.githubApp?.configured === true
                  const connected = logins[provider]
                  const installationNeeded =
                    provider === 'github' &&
                    logins.githubApp?.account !== null &&
                    logins.githubApp?.account !== undefined &&
                    !logins.githubApp.installed
                  let status = connected ? 'Connected' : 'Not connected'
                  if (connected && provider === 'github' && logins.githubApp?.account)
                    status = `Connected as ${logins.githubApp.account}`
                  if (attempt?.state === 'failed' || attempt?.state === 'expired') {
                    status = connected
                      ? `${status} · Reconnect not completed`
                      : (attempt.message ?? 'Connect again')
                  }
                  if (installationNeeded) status = 'Install the Loom GitHub App to continue'
                  if (waiting)
                    status = provider === 'codex' ? 'Waiting for sign-in' : 'Waiting for authorization'
                  if (!configured) status = 'GitHub App not configured on this runner'

                  return (
                    <div key={provider} className="settings-row connection-row">
                      <span
                        className="settings-dot"
                        data-tone={connected ? 'ok' : configured ? 'warn' : 'idle'}
                        aria-hidden="true"
                      />
                      <div className="settings-provider">
                        <span className="settings-name">{NAMES[provider]}</span>
                        <span className="settings-state">{status}</span>
                      </div>
                      {installationNeeded ? (
                        <>
                          <button
                            className="btn"
                            disabled={busy !== null || !logins.githubApp?.installUrl}
                            onClick={() => {
                              const url = logins.githubApp?.installUrl
                              if (url) void act(provider, () => window.loom.shell.openExternal(url))
                            }}
                          >
                            Install app
                          </button>
                          <button
                            className="btn btn-ghost"
                            disabled={busy !== null}
                            onClick={() => {
                              void act(provider, () => window.loom.logins.checkGithub())
                            }}
                          >
                            Check again
                          </button>
                        </>
                      ) : waiting && provider === 'github' ? (
                        <button
                          className="btn"
                          disabled={busy !== null}
                          onClick={() => {
                            if (attempt?.url)
                              void act(provider, () => window.loom.shell.openExternal(attempt.url!))
                          }}
                        >
                          Reopen page
                        </button>
                      ) : (
                        <button
                          className="btn"
                          disabled={!configured || busy !== null}
                          onClick={() => connect(provider)}
                        >
                          {busy === provider
                            ? 'Connecting…'
                            : waiting
                              ? 'Resume'
                              : connected
                                ? 'Reconnect'
                                : 'Connect'}
                        </button>
                      )}
                      {(connected || installationNeeded) && (
                        <button
                          className="btn btn-ghost"
                          disabled={busy !== null}
                          onClick={() => {
                            void act(provider, () => window.loom.logins.disconnect(provider))
                          }}
                        >
                          Disconnect
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {logins?.githubApp?.account && !logins.githubApp.installed && providers.includes('github') && (
              <p className="settings-note">
                An organization owner may need to approve installation. After installation, choose Check
                again.
              </p>
            )}
            {error !== null && modal === null && (
              <p className="connection-error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </section>
      <Modal
        open={modal === 'claude'}
        title="Connect Claude for cloud workspaces"
        onClose={close}
        footer={
          <>
            <button className="btn btn-ghost" onClick={close}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!token.trim() || busy !== null}
              onClick={() => {
                void act('claude', () => window.loom.logins.connectClaude(token), close)
              }}
            >
              {busy === 'claude' ? 'Connecting…' : 'Connect'}
            </button>
          </>
        }
      >
        <p className="settings-note">{host}</p>
        <p className="settings-note">Run this command in a terminal on your Mac:</p>
        <div className="connection-command">
          <code>claude setup-token</code>
          <Copy text="claude setup-token" label="Copy command" />
        </div>
        <p className="settings-note">Finish the instructions, then paste the token here.</p>
        <Field label="Token" hint="Saved for your cloud workspaces on this runner.">
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            data-autofocus
            value={token}
            onChange={(event) => setToken(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && token.trim())
                void act('claude', () => window.loom.logins.connectClaude(token), close)
            }}
          />
        </Field>
        {error !== null && (
          <p className="connection-error" role="alert">
            {error}
          </p>
        )}
      </Modal>
      <Modal
        open={modal === 'codex'}
        title="Connect Codex for cloud workspaces"
        onClose={close}
        footer={
          <button className="btn btn-ghost" onClick={close}>
            Done
          </button>
        }
      >
        <p className="settings-note">{host}</p>
        {(busy === 'codex' && !codex?.url) || codex?.state === 'starting' ? (
          <p role="status">Starting sign-in…</p>
        ) : codex?.state === 'waiting' ? (
          <>
            <p>Open this page and enter the code.</p>
            <div className="connection-command">
              <code>{codex.code}</code>
              <Copy text={codex.code ?? ''} label="Copy code" />
            </div>
            <p className="settings-note connection-url">{codex.url}</p>
            <button
              className="btn btn-primary"
              onClick={() => {
                if (codex.url) void act('codex', () => window.loom.shell.openExternal(codex.url!))
              }}
            >
              Open page
            </button>
            <p role="status" className="settings-note">
              Waiting for you to finish. Closing this dialog keeps the sign-in running.
            </p>
          </>
        ) : (
          <>
            <p role="status">{codex?.message ?? 'Sign-in has ended.'}</p>
            <button className="btn" disabled={busy !== null} onClick={() => connect('codex')}>
              Try again
            </button>
          </>
        )}
        {error !== null && (
          <p className="connection-error" role="alert">
            {error}
          </p>
        )}
      </Modal>
    </>
  )
}
