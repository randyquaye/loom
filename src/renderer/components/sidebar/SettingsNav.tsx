import { useEffect, type ReactNode } from 'react'
import { useCloud } from '../../state/cloud'
import { useOrganization } from '../../state/organization'
import { useProjects } from '../../state/projects'
import { DEFAULT_SETTINGS_PAGE, useUi, type SettingsPage } from '../../state/ui'
import {
  BotIcon,
  CloudIcon,
  ConsoleIcon,
  EditIcon,
  KeyboardIcon,
  ModelIcon,
  PuzzleIcon,
  SlidersIcon
} from '../ui/icons'
import { CloudStatusDot } from './CloudStatusDot'

interface NavPage {
  page: SettingsPage
  label: string
  /** An icon for app pages; a project's initial in a lettered tile. */
  glyph: ReactNode
  /** Shown right after the label, e.g. a live status mark. */
  trailing?: ReactNode
}

/** Each section lists its pages in alphabetical order. */
const GENERAL: NavPage[] = [
  { page: 'cloud', label: 'Cloud', glyph: <CloudIcon />, trailing: <CloudStatusDot /> },
  { page: 'env', label: 'Environment', glyph: <ConsoleIcon /> },
  { page: 'integrations', label: 'Integrations', glyph: <PuzzleIcon /> },
  { page: 'preferences', label: 'Preferences', glyph: <SlidersIcon /> },
  { page: 'shortcuts', label: 'Shortcuts', glyph: <KeyboardIcon /> }
]

/** Everything about the agents themselves: who they are signed in as, how they start, what they are told. */
const AGENTS: NavPage[] = [
  { page: 'agents', label: 'Agents', glyph: <BotIcon /> },
  { page: 'models', label: 'Default models', glyph: <ModelIcon /> },
  { page: 'instructions', label: 'Instructions', glyph: <EditIcon /> }
]

function NavRow({ page, label, glyph, trailing }: NavPage) {
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
      <span className="settings-nav-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="grow settings-nav-label">
        {label}
        {trailing}
      </span>
    </button>
  )
}

/** Sidebar body while Settings is open: grouped page nav in place of the project tree. */
export function SettingsNav() {
  const projects = useProjects((s) => s.projects)
  const connected = useCloud((state) => state.status.state === 'connected')
  const owner = useOrganization((state) => state.overview?.role === 'owner')
  useEffect(() => {
    if (connected) void useOrganization.getState().refresh()
    else useOrganization.getState().reset()
  }, [connected])
  return (
    <nav aria-label="Settings">
      <div className="section-label">General</div>
      <div className="project-block">
        {GENERAL.map((row) => (
          <NavRow key={row.page} {...row} />
        ))}
      </div>
      {connected && (
        <>
          <div className="section-label">Organization</div>
          <div className="project-block">
            <NavRow page="org-overview" label="Overview" glyph={<CloudIcon />} />
            {owner && <NavRow page="org-members" label="Members and invites" glyph={<BotIcon />} />}
            {owner && <NavRow page="org-log" label="Admin log" glyph={<ConsoleIcon />} />}
          </div>
        </>
      )}
      <div className="section-label">Agents</div>
      <div className="project-block">
        {AGENTS.map((row) => (
          <NavRow key={row.page} {...row} />
        ))}
      </div>
      <div className="section-label">Projects</div>
      <div className="project-block">
        {projects.map((p) => (
          <NavRow
            key={p.id}
            page={`project:${p.id}`}
            label={p.name}
            glyph={<span className="project-glyph">{p.name.slice(0, 1).toUpperCase()}</span>}
          />
        ))}
      </div>
      {projects.length === 0 && <div className="side-empty">No projects yet</div>}
    </nav>
  )
}
