import { useProjects } from '../state/projects'
import { DEFAULT_SETTINGS_PAGE, useUi, type SettingsPage } from '../state/ui'
import { Loadout } from './Loadout'
import { AgentsPage } from './settings/AgentsPage'
import { CloudPage } from './settings/CloudPage'
import { EnvPage } from './settings/EnvPage'
import { InstructionsPage } from './settings/InstructionsPage'
import { IntegrationsPage } from './settings/IntegrationsPage'
import { ProjectPage } from './settings/ProjectPage'
import { PreferencesPage } from './settings/PreferencesPage'
import { ShortcutsPage } from './settings/ShortcutsPage'
import { UpdatesPage } from './settings/UpdatesPage'
import { OrgOverviewPage } from './settings/OrgOverviewPage'
import { OrgMembersPage } from './settings/OrgMembersPage'
import { OrgAdminLogPage } from './settings/OrgAdminLogPage'
import { BotsPage } from './settings/BotsPage'
import { SubscriptionsPage } from './settings/SubscriptionsPage'
import { useOrganization } from '../state/organization'
import './settings.css'

const PAGE_HEAD: Record<
  Exclude<SettingsPage, `project:${string}`>,
  { title: string; description: string }
> = {
  preferences: { title: 'Preferences', description: 'Make Loom work the way you prefer.' },
  shortcuts: { title: 'Shortcuts', description: 'Keyboard shortcuts available across Loom.' },
  updates: { title: 'Updates', description: 'Keep this Mac’s Loom app up to date.' },
  integrations: { title: 'Integrations', description: 'Connect GitHub and configure services used by Loom.' },
  cloud: { title: 'Cloud', description: 'The runner your cloud workspaces live on, and your sign-in to it.' },
  'org-overview': { title: 'Organization', description: 'Your organization, membership, and cloud host.' },
  'org-members': {
    title: 'Members and invites',
    description: 'Invite colleagues and manage organization membership.'
  },
  'org-log': { title: 'Admin log', description: 'Changes made by your organization’s owners.' },
  'org-bots': { title: 'Bots', description: 'Configure organization bots and open their work.' },
  'org-subscriptions': {
    title: 'Subscriptions',
    description: 'Manage organization Claude and Codex accounts and bot capacity.'
  },
  env: { title: 'Environment', description: 'Variables passed to agents, terminals and run actions.' },
  instructions: { title: 'Instructions', description: 'Markdown appended to every agent session.' },
  models: { title: 'Default models', description: 'The models and effort new sessions start on.' },
  agents: { title: 'Agents', description: 'Connect Claude and Codex for local and cloud workspaces.' }
}

function isProjectPage(page: SettingsPage): page is `project:${string}` {
  return page.startsWith('project:')
}

/** Settings: one page at a time; the sidebar holds the page nav while this route is open. */
export function Settings() {
  const route = useUi((s) => s.route)
  const leaveSettings = useUi((s) => s.leaveSettings)
  const page = (route.name === 'settings' ? route.page : undefined) ?? DEFAULT_SETTINGS_PAGE
  const projectId = isProjectPage(page) ? page.slice('project:'.length) : null
  const organization = useOrganization((state) => state.overview)
  const organizationError = useOrganization((state) => state.error)
  const organizationLoading = useOrganization((state) => state.loading)
  const orgPage =
    page === 'org-overview' ||
    page === 'org-members' ||
    page === 'org-log' ||
    page === 'org-bots' ||
    page === 'org-subscriptions'
  const projectName = useProjects((s) =>
    projectId === null ? undefined : s.projects.find((p) => p.id === projectId)?.name
  )
  const head = isProjectPage(page)
    ? { title: projectName ?? 'Project', description: 'Custom instructions sent to the agent for each flow.' }
    : PAGE_HEAD[page]

  return (
    <main className="main elevated">
      <header className="settings-head">
        <button type="button" className="btn btn-ghost settings-back" onClick={leaveSettings}>
          <span aria-hidden="true">←</span>
          Back
        </button>
        <h1 className="settings-page-title">{head.title}</h1>
        <p className="settings-page-desc">{head.description}</p>
      </header>
      <div className="settings-scroll">
        {page === 'preferences' && <PreferencesPage />}
        {projectId !== null && <ProjectPage projectId={projectId} />}
        {page === 'shortcuts' && <ShortcutsPage />}
        {page === 'updates' && <UpdatesPage />}
        {page === 'integrations' && <IntegrationsPage />}
        {page === 'cloud' && <CloudPage />}
        {orgPage && organization === null && (
          <p className="settings-note" role={organizationError === null ? 'status' : 'alert'}>
            {organizationError ??
              (organizationLoading
                ? 'Loading organization…'
                : 'Connect to your organization under Cloud settings.')}
          </p>
        )}
        {organization !== null && page === 'org-overview' && <OrgOverviewPage />}
        {organization !== null && page === 'org-members' && <OrgMembersPage />}
        {organization !== null && page === 'org-log' && <OrgAdminLogPage />}
        {organization !== null && page === 'org-bots' && <BotsPage />}
        {organization !== null && page === 'org-subscriptions' && <SubscriptionsPage />}
        {page === 'env' && <EnvPage />}
        {page === 'instructions' && <InstructionsPage />}
        {page === 'models' && <Loadout />}
        {page === 'agents' && <AgentsPage />}
      </div>
    </main>
  )
}
