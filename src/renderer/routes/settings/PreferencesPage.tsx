import { usePreferences } from '../../state/preferences'

export function PreferencesPage() {
  const enabled = usePreferences((s) => s.completionSoundEnabled)
  const setEnabled = usePreferences((s) => s.setCompletionSoundEnabled)
  const steerByDefault = usePreferences((s) => s.steerByDefault)
  const setSteerByDefault = usePreferences((s) => s.setSteerByDefault)
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
      <label className="settings-row">
        <span className="settings-provider">
          <span className="settings-name">Steer by default</span>
        </span>
        <span className="settings-state" aria-hidden="true">
          {steerByDefault ? 'On' : 'Off'}
        </span>
        <input
          type="checkbox"
          role="switch"
          className="preferences-toggle"
          aria-label="Steer by default"
          aria-describedby="steer-default-note"
          checked={steerByDefault}
          onChange={(event) => setSteerByDefault(event.target.checked)}
        />
      </label>
      <p className="settings-note" id="steer-default-note">
        Send new messages to the running turn when steering is supported. Otherwise, queue them.
      </p>
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
