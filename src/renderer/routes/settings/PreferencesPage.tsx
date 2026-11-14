import type { ClaudeMode, CodexMode } from '../../../shared/models'
import { Dropdown } from '../../components/ui/Dropdown'
import { usePreferences } from '../../state/preferences'

const CLAUDE_MODE_LABELS: Record<ClaudeMode, string> = {
  auto: 'Auto: reviews each action',
  bypass: 'Bypass: never asks'
}

const CODEX_MODE_LABELS: Record<CodexMode, string> = {
  sandbox: 'Sandbox: asks to go further',
  bypass: 'Bypass: never asks'
}

const options = <T extends string>(labels: Record<T, string>) =>
  (Object.entries(labels) as Array<[T, string]>).map(([value, label]) => ({ value, label }))

export function PreferencesPage() {
  const enabled = usePreferences((s) => s.completionSoundEnabled)
  const setEnabled = usePreferences((s) => s.setCompletionSoundEnabled)
  const steerByDefault = usePreferences((s) => s.steerByDefault)
  const setSteerByDefault = usePreferences((s) => s.setSteerByDefault)
  const agentModes = usePreferences((s) => s.agentModes)
  const setClaudeMode = usePreferences((s) => s.setClaudeMode)
  const setCodexMode = usePreferences((s) => s.setCodexMode)
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
      <div className="settings-label">Cloud agent permissions</div>
      <div className="settings-row preferences-mode">
        <span className="settings-provider">
          <span className="settings-name">Claude</span>
        </span>
        <Dropdown
          value={agentModes.claude}
          options={options(CLAUDE_MODE_LABELS)}
          onChange={(mode) => setClaudeMode(mode as ClaudeMode)}
        />
      </div>
      <div className="settings-row preferences-mode">
        <span className="settings-provider">
          <span className="settings-name">Codex</span>
        </span>
        <Dropdown
          value={agentModes.codex}
          options={options(CODEX_MODE_LABELS)}
          onChange={(mode) => setCodexMode(mode as CodexMode)}
        />
      </div>
      <p className="settings-note">
        New cloud workspaces start their agents in these modes. Workspaces that already exist keep the mode
        they were created with. Local workspaces use this Mac&apos;s own Claude and Codex settings.
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
