import { useProjects } from '../state/projects'
import { DEFAULT_SETTINGS_PAGE, useUi, type SettingsPage } from '../state/ui'
import { Loadout } from './Loadout'
import { AgentsPage } from './settings/AgentsPage'
import { EnvPage } from './settings/EnvPage'
import { InstructionsPage } from './settings/InstructionsPage'
import { IntegrationsPage } from './settings/IntegrationsPage'
import { ProjectPage } from './settings/ProjectPage'
import { PreferencesPage } from './settings/PreferencesPage'
import { ShortcutsPage } from './settings/ShortcutsPage'
import './settings.css'

const PAGE_HEAD: Record<
  Exclude<SettingsPage, `project:${string}`>,
  { title: string; description: string }
> = {
  preferences: { title: 'Preferences', description: 'Make Loom work the way you prefer.' },
  shortcuts: { title: 'Shortcuts', description: 'Keyboard shortcuts available across Loom.' },
  integrations: { title: 'Integrations', description: 'Connect GitHub and Linear to your workspaces.' },
  env: { title: 'Environment', description: 'Variables passed to agents, terminals and run actions.' },
  instructions: { title: 'Instructions', description: 'Markdown appended to every agent session.' },
  models: { title: 'Default models', description: 'The models and effort new sessions start on.' },
  agents: { title: 'Agents', description: 'Sign-in status and API keys for each agent backend.' }
}

function isProjectPage(page: SettingsPage): page is `project:${string}` {
  return page.startsWith('project:')
}

/** Settings: one page at a time; the sidebar holds the page nav while this route is open. */
export function Settings() {
  const route = useUi((s) => s.route)
  const page = (route.name === 'settings' ? route.page : undefined) ?? DEFAULT_SETTINGS_PAGE
  const projectId = isProjectPage(page) ? page.slice('project:'.length) : null
  const projectName = useProjects((s) =>
    projectId === null ? undefined : s.projects.find((p) => p.id === projectId)?.name
  )
  const head = isProjectPage(page)
    ? { title: projectName ?? 'Project', description: 'Custom instructions sent to the agent for each flow.' }
    : PAGE_HEAD[page]

  return (
    <main className="main elevated">
      <header className="settings-head">
        <h1 className="settings-page-title">{head.title}</h1>
        <p className="settings-page-desc">{head.description}</p>
      </header>
      <div className="settings-scroll">
        {page === 'preferences' && <PreferencesPage />}
        {projectId !== null && <ProjectPage projectId={projectId} />}
        {page === 'shortcuts' && <ShortcutsPage />}
        {page === 'integrations' && <IntegrationsPage />}
        {page === 'env' && <EnvPage />}
        {page === 'instructions' && <InstructionsPage />}
        {page === 'models' && <Loadout />}
        {page === 'agents' && <AgentsPage />}
      </div>
    </main>
  )
}
