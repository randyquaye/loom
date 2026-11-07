import { useCallback, useEffect, useState } from 'react'
import type { SecretPresence } from '../../../shared/ipc-contract'
import type { BackendId } from '../../../shared/models'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { useToasts } from '../../components/ui/Toast'
import { useProjects } from '../../state/projects'

const KEY_BACKENDS: BackendId[] = ['gemini', 'qwen']
const CLI_BACKENDS: BackendId[] = ['codex', 'claude']

function statusTone(state: string | undefined): 'ok' | 'warn' | 'danger' | 'idle' {
  if (state === 'ready') return 'ok'
  if (state === 'needs-key' || state === 'needs-login') return 'warn'
  if (state === 'error') return 'danger'
  return 'idle'
}

function statusText(state: string | undefined): string {
  if (state === undefined) return 'Checking…'
  if (state === 'ready') return 'Ready'
  if (state === 'needs-key') return 'API key required'
  if (state === 'needs-login') return 'CLI login required'
  if (state === 'error') return 'Unavailable'
  return state
}

/** Settings "Agents": per-backend auth status, CLI login hints and API-key management. */
export function AgentsPage() {
  const statusByProvider = useProjects((s) => s.statusByProvider)
  const push = useToasts((s) => s.push)
  const [presence, setPresence] = useState<Record<string, SecretPresence>>({})
  const [editing, setEditing] = useState<BackendId | null>(null)
  const [value, setValue] = useState('')

  async function refresh() {
    const entries = await Promise.all(
      KEY_BACKENDS.map(async (id) => [id, await window.loom.secrets.has(id)] as const)
    )
    setPresence(Object.fromEntries(entries))
  }

  useEffect(() => {
    void refresh()
  }, [])

  // Modal re-runs its focus effect whenever onClose changes identity, so keep it stable.
  const closeEditor = useCallback(() => {
    setEditing(null)
    setValue('')
  }, [])

  function save() {
    const id = editing
    if (id === null || !value) return
    window.loom.secrets
      .set(id, value)
      .then(() => {
        push(`Saved ${id} key`)
        closeEditor()
        void refresh()
        void useProjects.getState().load()
      })
      .catch((e: unknown) => push(`Could not save ${id} key: ${String(e)}`, 'err'))
  }

  function remove(id: BackendId) {
    window.loom.secrets
      .delete(id)
      .then(() => {
        push(`Removed ${id} key`)
        void refresh()
        void useProjects.getState().load()
      })
      .catch((e: unknown) => push(`Could not remove ${id} key: ${String(e)}`, 'err'))
  }

  return (
    <>
      <section className="settings-section">
        <div className="settings-label">Providers</div>
        <div className="settings-list">
          {CLI_BACKENDS.map((id) => {
            const state = statusByProvider[id]
            return (
              <div key={id} className="settings-row">
                <span className="settings-dot" data-tone={statusTone(state)} aria-hidden="true" />
                <div className="settings-provider">
                  <span className="settings-name">{id}</span>
                  <span className="settings-state">{statusText(state)}</span>
                </div>
                <span className="settings-mask">CLI login</span>
              </div>
            )
          })}
          {KEY_BACKENDS.map((id) => {
            const p = presence[id]
            const state = statusByProvider[id]
            return (
              <div key={id} className="settings-row">
                <span className="settings-dot" data-tone={statusTone(state)} aria-hidden="true" />
                <div className="settings-provider">
                  <span className="settings-name">{id}</span>
                  <span className="settings-state">{statusText(state)}</span>
                </div>
                <span className="settings-mask">{p?.present ? (p.masked ?? 'stored') : 'not set'}</span>
                <button className="btn" onClick={() => setEditing(id)}>
                  {p?.present ? 'Replace' : 'Add'}
                </button>
                <button className="btn btn-ghost" disabled={!p?.present} onClick={() => remove(id)}>
                  Remove
                </button>
              </div>
            )
          })}
        </div>
        <p className="settings-note">
          API keys are encrypted with the macOS Keychain and never leave this machine. codex and claude use
          their own CLI logins; run <code>codex login</code> or <code>claude</code> in a terminal to sign in.
        </p>
      </section>
      <Modal
        open={editing !== null}
        title={`${editing ?? ''} API key`}
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
        <Field label="API key" hint="Stored encrypted in the macOS Keychain.">
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
    </>
  )
}
