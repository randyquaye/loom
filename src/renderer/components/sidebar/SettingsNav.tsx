import { useProjects } from '../../state/projects'
import { DEFAULT_SETTINGS_PAGE, useUi, type SettingsPage } from '../../state/ui'

const GENERAL: { page: SettingsPage; label: string; glyph: string }[] = [
  { page: 'shortcuts', label: 'Shortcuts', glyph: '⌘' },
  { page: 'integrations', label: 'Integrations', glyph: '⇄' },
  { page: 'env', label: 'Environment', glyph: '$' },
  { page: 'instructions', label: 'Instructions', glyph: '✎' },
  { page: 'models', label: 'Default models', glyph: '◇' }
]

function NavRow({ page, label, glyph }: { page: SettingsPage; label: string; glyph: string }) {
  const route = useUi((s) => s.route)
  const navigate = useUi((s) => s.navigate)
  const current = route.name === 'settings' && (route.page ?? DEFAULT_SETTINGS_PAGE) === page
  return (
    <button
      type="button"
      className="project-row settings-nav-row"
      data-active={current}
      aria-current={current ? 'page' : undefined}
      onClick={() => navigate({ name: 'settings', page })}
    >
      <span className="project-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="grow settings-nav-label">{label}</span>
    </button>
  )
}

/** Sidebar body while Settings is open: grouped page nav in place of the project tree. */
export function SettingsNav() {
  const projects = useProjects((s) => s.projects)
  return (
    <nav aria-label="Settings">
      <div className="section-label">General</div>
      <div className="project-block">
        {GENERAL.map((row) => (
          <NavRow key={row.page} {...row} />
        ))}
      </div>
      <div className="section-label">Agents</div>
      <div className="project-block">
        <NavRow page="agents" label="Agents" glyph="◉" />
      </div>
      <div className="section-label">Projects</div>
      <div className="project-block">
        {projects.map((p) => (
          <NavRow
            key={p.id}
            page={`project:${p.id}`}
            label={p.name}
            glyph={p.name.slice(0, 1).toUpperCase()}
          />
        ))}
      </div>
      {projects.length === 0 && <div className="side-empty">No projects yet</div>}
    </nav>
  )
}
