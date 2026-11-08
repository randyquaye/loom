import { useCallback, useEffect, useState } from 'react'
import type { GithubStatus, IntegrationsStatus, SecretPresence } from '../../../shared/ipc-contract'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { useToasts } from '../../components/ui/Toast'
import { SPEECH_SPEED_MAX, SPEECH_SPEED_MIN, useDefaults } from '../../state/defaults'

// Integration states differ from provider states, so they get their own mappers.
function githubTone(status: GithubStatus): 'ok' | 'warn' | 'danger' {
  if (status.state === 'ready') return 'ok'
  if (status.state === 'error') return 'danger'
  return 'warn'
}

function githubText(status: GithubStatus): string {
  switch (status.state) {
    case 'ready':
      return 'Ready'
    case 'not-installed':
      return 'GitHub CLI not installed'
    case 'not-authenticated':
      return 'Sign in required'
    case 'error':
      return 'Unavailable'
  }
}

// Stored-key integrations (Linear, ElevenLabs): the row follows key presence; null is "not checked yet".
function presenceTone(presence: SecretPresence | null): 'ok' | 'warn' | 'idle' {
  if (presence === null) return 'idle'
  return presence.present ? 'ok' : 'warn'
}

function presenceText(presence: SecretPresence | null): string {
  if (presence === null) return 'Checking…'
  return presence.present ? 'Ready' : 'API key required'
}

/** Settings "Integrations": GitHub CLI status plus stored keys for Linear and ElevenLabs. */
export function IntegrationsPage() {
  const push = useToasts((s) => s.push)
  const voiceId = useDefaults((s) => s.voiceId)
  const setVoiceId = useDefaults((s) => s.setVoiceId)
  const [voiceValue, setVoiceValue] = useState(voiceId)
  const speechSpeed = useDefaults((s) => s.speechSpeed)
  const setSpeechSpeed = useDefaults((s) => s.setSpeechSpeed)
  const [speedValue, setSpeedValue] = useState(String(speechSpeed))
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [editingEl, setEditingEl] = useState(false)
  const [elValue, setElValue] = useState('')
  const [integrations, setIntegrations] = useState<IntegrationsStatus | null>(null)
  const [integrationsError, setIntegrationsError] = useState<string | null>(null)
  const [linearKey, setLinearKey] = useState<SecretPresence | null>(null)
  const [elKey, setElKey] = useState<SecretPresence | null>(null)

  function refreshIntegrations() {
    window.loom.linear
      .hasKey()
      .then(setLinearKey)
      .catch((err: unknown) => push(`Could not check linear key: ${String(err)}`, 'err'))
    window.loom.elevenlabs
      .hasKey()
      .then(setElKey)
      .catch((err: unknown) => push(`Could not check elevenlabs key: ${String(err)}`, 'err'))
    window.loom.integrations
      .status()
      .then((status) => {
        setIntegrations(status)
        setIntegrationsError(null)
      })
      .catch((err: unknown) => setIntegrationsError(String(err)))
  }

  useEffect(() => {
    let live = true
    window.loom.linear
      .hasKey()
      .then((p) => {
        if (live) setLinearKey(p)
      })
      .catch(() => {
        // Leave the row at "Checking…"; integrations.status() surfaces the failure below.
      })
    window.loom.elevenlabs
      .hasKey()
      .then((p) => {
        if (live) setElKey(p)
      })
      .catch(() => {
        // Same as linear: the status probe below surfaces the failure.
      })
    window.loom.integrations
      .status()
      .then((status) => {
        if (live) setIntegrations(status)
      })
      .catch((err: unknown) => {
        if (live) setIntegrationsError(String(err))
      })
    return () => {
      live = false
    }
  }, [])

  // Modal re-runs its focus effect whenever onClose changes identity, so keep it stable.
  const closeEditor = useCallback(() => {
    setEditing(false)
    setValue('')
  }, [])
  const closeElEditor = useCallback(() => {
    setEditingEl(false)
    setElValue('')
  }, [])

  function save() {
    if (!editing || !value) return
    window.loom.linear
      .setKey(value)
      .then(() => {
        push('Saved linear key')
        closeEditor()
        refreshIntegrations()
      })
      .catch((e: unknown) => push(`Could not save linear key: ${String(e)}`, 'err'))
  }

  function remove() {
    window.loom.linear
      .deleteKey()
      .then(() => {
        push('Removed linear key')
        refreshIntegrations()
      })
      .catch((e: unknown) => push(`Could not remove linear key: ${String(e)}`, 'err'))
  }

  function saveEl() {
    if (!editingEl || !elValue) return
    window.loom.elevenlabs
      .setKey(elValue)
      .then(() => {
        push('Saved ElevenLabs key')
        closeElEditor()
        refreshIntegrations()
      })
      .catch((e: unknown) => push(`Could not save ElevenLabs key: ${String(e)}`, 'err'))
  }

  function removeEl() {
    window.loom.elevenlabs
      .deleteKey()
      .then(() => {
        push('Removed ElevenLabs key')
        refreshIntegrations()
      })
      .catch((e: unknown) => push(`Could not remove ElevenLabs key: ${String(e)}`, 'err'))
  }

  function saveVoice() {
    try {
      setVoiceId(voiceValue)
      setSpeechSpeed(speedValue)
      const saved = useDefaults.getState()
      setVoiceValue(saved.voiceId)
      setSpeedValue(String(saved.speechSpeed))
      push('Saved voice')
    } catch (err) {
      push(`Could not save voice: ${String(err)}`, 'err')
    }
  }

  return (
    <>
      <section className="settings-section">
        <div className="settings-label">Integrations</div>
        <div className="settings-list">
          <div className="settings-row">
            <span
              className="settings-dot"
              data-tone={
                integrationsError !== null
                  ? 'danger'
                  : integrations === null
                    ? 'idle'
                    : githubTone(integrations.github)
              }
              aria-hidden="true"
            />
            <div className="settings-provider">
              <span className="settings-name">github</span>
              <span className="settings-state">
                {integrationsError !== null
                  ? 'Unavailable'
                  : integrations === null
                    ? 'Checking…'
                    : githubText(integrations.github)}
              </span>
            </div>
            <span className="settings-mask">
              {integrations?.github.state === 'ready' ? integrations.github.account : null}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-dot" data-tone={presenceTone(linearKey)} aria-hidden="true" />
            <div className="settings-provider">
              <span className="settings-name">linear</span>
              <span className="settings-state">{presenceText(linearKey)}</span>
            </div>
            <span className="settings-mask">
              {linearKey?.present ? (linearKey.masked ?? 'stored') : 'not set'}
            </span>
            <button className="btn" onClick={() => setEditing(true)}>
              {linearKey?.present ? 'Replace' : 'Add'}
            </button>
            <button className="btn btn-ghost" disabled={!linearKey?.present} onClick={remove}>
              Remove
            </button>
          </div>
          <div className="settings-row">
            <span className="settings-dot" data-tone={presenceTone(elKey)} aria-hidden="true" />
            <div className="settings-provider">
              <span className="settings-name">elevenlabs</span>
              <span className="settings-state">{presenceText(elKey)}</span>
            </div>
            <span className="settings-mask">{elKey?.present ? (elKey.masked ?? 'stored') : 'not set'}</span>
            <button className="btn" onClick={() => setEditingEl(true)}>
              {elKey?.present ? 'Replace' : 'Add'}
            </button>
            <button className="btn btn-ghost" disabled={!elKey?.present} onClick={removeEl}>
              Remove
            </button>
          </div>
        </div>
        {integrationsError !== null && (
          <p className="settings-note" role="alert">
            Couldn’t check integrations: {integrationsError}
          </p>
        )}
        <p className="settings-note">
          Loom stores no GitHub credential: the <code>gh</code> CLI keeps it in the macOS keyring. Run{' '}
          <code>gh auth login</code> in a terminal to sign in. The Linear and ElevenLabs API keys are stored
          encrypted in the macOS Keychain; Linear’s never leaves this machine except to api.linear.app,
          ElevenLabs’ except to api.elevenlabs.io.
        </p>
      </section>
      <section className="settings-section">
        <div className="settings-label">ElevenLabs voice</div>
        <Field
          label="Voice ID"
          hint="Applies to the next spoken reply. Leave blank to restore the default voice."
        >
          <input
            className="input"
            value={voiceValue}
            maxLength={128}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setVoiceValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveVoice()
            }}
          />
        </Field>
        <Field
          label="Speed"
          hint={`${SPEECH_SPEED_MIN}–${SPEECH_SPEED_MAX}; 1.0 is normal. Leave blank to restore 1.0.`}
        >
          <input
            className="input"
            type="number"
            min={SPEECH_SPEED_MIN}
            max={SPEECH_SPEED_MAX}
            step={0.05}
            value={speedValue}
            onChange={(e) => setSpeedValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveVoice()
            }}
          />
        </Field>
        <div>
          <button className="btn" onClick={saveVoice}>
            Save voice
          </button>
        </div>
      </section>
      <Modal
        open={editing}
        title="Linear API key"
        onClose={closeEditor}
        footer={
          <>
            <button className="btn btn-ghost" onClick={closeEditor}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!value} onClick={save}>
              Save
            </button>
          </>
        }
      >
        <Field
          label="API key"
          hint="Stored encrypted in the macOS Keychain. Create one in Linear → Settings → API."
        >
          <input
            className="input"
            type="password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
        </Field>
      </Modal>
      <Modal
        open={editingEl}
        title="ElevenLabs API key"
        onClose={closeElEditor}
        footer={
          <>
            <button className="btn btn-ghost" onClick={closeElEditor}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!elValue} onClick={saveEl}>
              Save
            </button>
          </>
        }
      >
        <Field
          label="API key"
          hint="Stored encrypted in the macOS Keychain. Create one in ElevenLabs → Profile → API keys."
        >
          <input
            className="input"
            type="password"
            autoFocus
            value={elValue}
            onChange={(e) => setElValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveEl()
            }}
          />
        </Field>
      </Modal>
    </>
  )
}
