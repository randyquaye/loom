import { useEffect, useState } from 'react'
import { useToasts } from '../../components/ui/Toast'

// Main refuses anything longer; matches the IPC contract cap.
const MAX_INSTRUCTIONS = 16000

/** Settings section editing one scope's markdown instructions; the loaded text is the dirty baseline. */
export function InstructionsEditor({
  scope,
  projectId,
  label,
  hint
}: {
  scope: 'instance' | 'project'
  projectId: string | null
  label: string
  hint: string
}) {
  const push = useToasts((s) => s.push)
  const [saved, setSaved] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dirty = saved !== null && text !== saved

  useEffect(() => {
    let live = true
    setSaved(null)
    setError(null)
    window.loom.instructions
      .get(scope, projectId)
      .then((loaded) => {
        if (!live) return
        setSaved(loaded)
        setText(loaded)
      })
      .catch((err: unknown) => {
        if (live) setError(String(err))
      })
    return () => {
      live = false
    }
  }, [scope, projectId])

  async function save() {
    if (saving || !dirty) return
    setSaving(true)
    try {
      await window.loom.instructions.set(scope, projectId, text)
      setSaved(text)
      push('Saved instructions')
    } catch (err) {
      push(`Could not save instructions: ${String(err)}`, 'err')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-label-row">
        <div className="settings-label">{label}</div>
        <button type="button" className="btn" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="settings-note">{hint}</p>
      {saved === null && error === null ? (
        <div className="settings-list">
          <div className="settings-row">
            <span className="settings-state">Loading…</span>
          </div>
        </div>
      ) : (
        error === null && (
          <textarea
            className="input mono"
            rows={12}
            maxLength={MAX_INSTRUCTIONS}
            spellCheck={false}
            aria-label={label}
            placeholder="Empty adds nothing to the system prompt."
            value={text}
            disabled={saving}
            onChange={(e) => setText(e.target.value)}
          />
        )
      )}
      {error !== null && (
        <p className="settings-note" role="alert">
          Couldn’t load instructions: {error}
        </p>
      )}
    </section>
  )
}
