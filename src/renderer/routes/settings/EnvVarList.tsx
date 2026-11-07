import { useCallback, useEffect, useState } from 'react'
import type { EnvScope, EnvVarRow } from '../../../shared/ipc-contract'
import { Field } from '../../components/ui/Field'
import { Modal } from '../../components/ui/Modal'
import { useToasts } from '../../components/ui/Toast'

/**
 * Electron wraps errors thrown in main ("Error invoking remote method …: Error: …"), so the
 * ENV_NAME_REJECTED prefix is matched anywhere in the message and main's text is shown as-is.
 */
function rejection(err: unknown): string | null {
  const rejected = /ENV_NAME_REJECTED:\s*([\s\S]*)$/.exec(String(err))
  return rejected === null ? null : (rejected[1] ?? '')
}

/** Name is fixed when replacing; null editor is closed. */
type Editor = { name: string; replacing: boolean } | null

/**
 * Settings environment section for one scope: name + masked value rows with Replace / Remove,
 * and the name/value editor modal. Values only ever travel renderer → main; rows carry masks.
 */
export function EnvVarList({
  scope,
  projectId,
  intro
}: {
  scope: EnvScope
  projectId: string | null
  intro: string
}) {
  const push = useToasts((s) => s.push)
  const [rows, setRows] = useState<EnvVarRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor>(null)
  const [value, setValue] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.loom.env
      .list(scope, projectId)
      .then((list) => {
        setRows(list)
        setError(null)
      })
      .catch((err: unknown) => setError(String(err)))
  }, [scope, projectId])

  useEffect(() => {
    let live = true
    window.loom.env
      .list(scope, projectId)
      .then((list) => {
        if (live) setRows(list)
      })
      .catch((err: unknown) => {
        if (live) setError(String(err))
      })
    return () => {
      live = false
    }
  }, [scope, projectId])

  // Modal re-runs its focus effect whenever onClose changes identity, so keep it stable.
  const closeEditor = useCallback(() => {
    setEditor(null)
    setValue('')
  }, [])

  const name = editor?.name.trim() ?? ''

  function save() {
    if (editor === null || !name || !value) return
    window.loom.env
      .set(scope, projectId, name, value)
      .then(() => {
        push(`Saved ${name}`)
        closeEditor()
        refresh()
      })
      .catch((e: unknown) => push(rejection(e) ?? `Could not save ${name}: ${String(e)}`, 'err'))
  }

  function remove(target: string) {
    setRemoving(target)
    window.loom.env
      .delete(scope, projectId, target)
      .then(() => {
        push(`Removed ${target}`)
        refresh()
      })
      .catch((e: unknown) => push(`Could not remove ${target}: ${String(e)}`, 'err'))
      .finally(() => setRemoving(null))
  }

  const empty = rows !== null && rows.length === 0
  const add = (
    <button className="btn" onClick={() => setEditor({ name: '', replacing: false })}>
      Add
    </button>
  )

  return (
    <>
      <section className="settings-section">
        <div className="settings-label-row">
          <div className="settings-label">Environment</div>
          {rows !== null && !empty && add}
        </div>
        <p className="settings-note">{intro}</p>
        <div className="settings-list">
          {rows?.map((row) => (
            <div key={row.name} className="settings-row">
              <div className="settings-provider">
                <span className="settings-name env-name">{row.name}</span>
              </div>
              <span className="settings-mask">{row.masked}</span>
              <button className="btn" onClick={() => setEditor({ name: row.name, replacing: true })}>
                Replace
              </button>
              <button
                className="btn btn-ghost"
                disabled={removing === row.name}
                onClick={() => remove(row.name)}
              >
                Remove
              </button>
            </div>
          ))}
          {empty && (
            <div className="settings-row">
              <div className="settings-provider">
                <span className="settings-state">No variables yet.</span>
              </div>
              {add}
            </div>
          )}
          {rows === null && error === null && (
            <div className="settings-row">
              <span className="settings-state">Loading…</span>
            </div>
          )}
        </div>
        {error !== null && (
          <p className="settings-note" role="alert">
            Couldn’t load variables: {error}
          </p>
        )}
      </section>
      <Modal
        open={editor !== null}
        title={editor?.replacing ? `Replace ${editor.name}` : 'Environment variable'}
        onClose={closeEditor}
        footer={
          <>
            <button className="btn btn-ghost" onClick={closeEditor}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={!name || !value} onClick={save}>
              Save
            </button>
          </>
        }
      >
        <Field label="Name" hint="A shell identifier. LOOM_* and process-reserved names are refused.">
          <input
            className="input"
            placeholder="DEPLOY_TOKEN"
            spellCheck={false}
            autoCapitalize="off"
            readOnly={editor?.replacing === true}
            value={editor?.name ?? ''}
            onChange={(e) => setEditor((prev) => (prev === null ? prev : { ...prev, name: e.target.value }))}
          />
        </Field>
        <Field label="Value" hint="Stored encrypted in the macOS Keychain.">
          <input
            className="input"
            type="password"
            autoFocus
            data-autofocus
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
