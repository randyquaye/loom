import { usePreferences } from '../../state/preferences'

export function PreferencesPage() {
  const enabled = usePreferences((s) => s.completionSoundEnabled)
  const setEnabled = usePreferences((s) => s.setCompletionSoundEnabled)
  return (
    <section className="settings-section">
      <label className="settings-row">
        <span className="settings-provider">
          <span className="settings-name">Completion sound</span>
          <span id="completion-sound-help" className="settings-state">
            Play a chime when a session finishes while you’re elsewhere.
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          className="preferences-toggle"
          aria-label="Completion sound"
          aria-describedby="completion-sound-help"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
      </label>
      <p className="settings-note">
        <a href="https://freesound.org/people/Robo9418/sounds/726858/" target="_blank" rel="noreferrer">
          Doorbell Chime in the key of C by Robo9418
        </a>{' '}
        ·{' '}
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
          CC BY 4.0
        </a>
        . Shortened and faded to 0.7 seconds.
      </p>
    </section>
  )
}
