const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['⌘', 'K'], label: 'Open the command palette' },
  { keys: ['⌘', 'N'], label: 'New workspace' },
  { keys: ['⌘', 'T'], label: 'New session tab in the open workspace' },
  { keys: ['/'], label: 'Focus the Home search' },
  { keys: ['↵'], label: 'Send the message' },
  { keys: ['⌘', '↵'], label: 'Send now while a turn is running' },
  { keys: ['⇧', '↵'], label: 'Insert a newline' },
  { keys: ['⌘', '⇧', '/'], label: 'Cycle effort for the session about to start' },
  { keys: ['⌘', '⇧', 'V'], label: 'Toggle voice mode' },
  { keys: ['Space'], label: 'Hold to talk in voice mode' },
  { keys: ['Esc'], label: 'Close the topmost overlay' }
]

/** Settings "Shortcuts": the keyboard shortcuts the app handles today. */
export function ShortcutsPage() {
  return (
    <section className="settings-section">
      <dl className="settings-list shortcut-list">
        {SHORTCUTS.map((s) => (
          <div key={s.label} className="settings-row shortcut-row">
            <dt className="shortcut-keys">
              {s.keys.map((k) => (
                <kbd key={k} className="kbd">
                  {k}
                </kbd>
              ))}
            </dt>
            <dd className="shortcut-label">{s.label}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
