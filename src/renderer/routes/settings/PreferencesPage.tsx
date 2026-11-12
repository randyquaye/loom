import { usePreferences } from '../../state/preferences'

export function PreferencesPage() {
  const enabled = usePreferences((s) => s.completionSoundEnabled)
  const setEnabled = usePreferences((s) => s.setCompletionSoundEnabled)
  return (
    <section className="settings-section">
      <label className="settings-row">
        <span className="settings-provider">
          <span className="settings-name">Completion sound</span>
        </span>
        <span className="settings-state" aria-hidden="true">
          {enabled ? 'On' : 'Off'}
        </span>
        <input
          type="checkbox"
          role="switch"
          className="preferences-toggle"
          aria-label="Completion sound"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
      </label>
      <p className="settings-note">
        Claude and ChatGPT icons by{' '}
        <a href="https://icons8.com/" target="_blank" rel="noreferrer">
          Icons8
        </a>
        .
      </p>
    </section>
  )
}
