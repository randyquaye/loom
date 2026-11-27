import { NewWorkspaceForm } from '../components/modals/NewWorkspaceForm'
import { useProjects } from '../state/projects'
import { useUi } from '../state/ui'
import { ConversationList } from './ConversationList'
import './home.css'

export function Home() {
  const workspacesByProject = useProjects((s) => s.workspacesByProject)
  const navigate = useUi((s) => s.navigate)
  const recent = Object.values(workspacesByProject)
    .flat()
    .filter((workspace) => !workspace.archived)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)

  return (
    <main className="main home home-start">
      <div className="home-start-inner">
        <h1 className="home-title">Start working on something</h1>
        <NewWorkspaceForm projectId={null} presentation="home" />
        <div className="home-key-hint">Enter to start · Shift + Enter for a new line</div>
        <section className="home-recent" aria-labelledby="home-recent-title">
          <div className="home-recent-head">
            <h2 id="home-recent-title">Recent conversations</h2>
            <button
              type="button"
              className="btn btn-ghost"
              aria-label="See all conversations"
              onClick={() => navigate({ name: 'conversations' })}
            >
              See all <span aria-hidden="true">→</span>
            </button>
          </div>
          {recent.length > 0 ? (
            <ConversationList workspaces={recent} />
          ) : (
            <p className="home-recent-empty">Your conversations will appear here once you start working.</p>
          )}
        </section>
      </div>
    </main>
  )
}
