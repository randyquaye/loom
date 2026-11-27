import type { WorkspaceRow } from '../../shared/ipc-contract'
import { BranchIcon } from '../components/ui/icons'
import { relativeTime } from '../components/ui/relativeTime'
import { useProjects } from '../state/projects'
import { useSessions } from '../state/sessions'
import { useUi } from '../state/ui'

/** Both history views resume the latest open session, falling back to the latest closed one. */
export function ConversationList({ workspaces }: { workspaces: WorkspaceRow[] }) {
  const projects = useProjects((s) => s.projects)
  const navigate = useUi((s) => s.navigate)
  const setActive = useSessions((s) => s.setActive)
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))

  async function resume(workspaceId: string) {
    try {
      const sessions = await window.loom.sessions.list(workspaceId)
      const session = sessions.filter((s) => s.closedAt === null).at(-1) ?? sessions.at(-1)
      if (session !== undefined) setActive(workspaceId, session.id)
    } catch {
      // Opening the workspace still allows its own session loader to recover.
    }
    navigate({ name: 'workspace', workspaceId })
  }

  return workspaces.map((workspace) => (
    <button key={workspace.id} type="button" className="home-card" onClick={() => void resume(workspace.id)}>
      <BranchIcon />
      <span className="grow home-card-name">{workspace.name}</span>
      <span className="home-card-project">{projectNames.get(workspace.projectId) ?? 'Unknown project'}</span>
      <span className="home-time">{relativeTime(workspace.createdAt)}</span>
    </button>
  ))
}
