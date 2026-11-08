import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceRow } from '../../shared/ipc-contract'
import { Popover } from '../components/ui/Popover'
import { relativeTime } from '../components/ui/relativeTime'
import { WeaveMark } from '../components/ui/WeaveMark'
import { useProjects } from '../state/projects'
import { useSessions } from '../state/sessions'
import { useUi } from '../state/ui'
import './home.css'

/** Home lists conversations (live workspaces), newest first; a row resumes its latest session. */
export function Home() {
  const projects = useProjects((s) => s.projects)
  const workspacesByProject = useProjects((s) => s.workspacesByProject)
  const navigate = useUi((s) => s.navigate)
  const setActive = useSessions((s) => s.setActive)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<string | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const filterRef = useRef<HTMLButtonElement>(null)
  // Stable identity: Popover re-binds its listeners whenever onClose changes.
  const closeFilter = useCallback(() => setFilterOpen(false), [])
  const openNewSession = useUi((s) => s.openNewSession)
  const openAddProject = useUi((s) => s.openAddProject)

  function startSomething(prompt?: string) {
    const first = Object.values(workspacesByProject)
      .flat()
      .find((w) => !w.archived)
    if (prompt !== undefined) useUi.getState().setDraft(prompt)
    if (first === undefined) {
      openAddProject()
      return
    }
    // openNewSession navigates and puts the workspace into compose mode.
    openNewSession(first.id)
  }

  async function resume(workspaceId: string) {
    try {
      const sessions = await window.loom.sessions.list(workspaceId)
      const session = sessions.filter((s) => s.closedAt === null).at(-1) ?? sessions.at(-1)
      if (session !== undefined) setActive(workspaceId, session.id)
    } catch {
      // The workspace route loads its own sessions; opening it is still the right outcome.
    }
    navigate({ name: 'workspace', workspaceId })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (e.key !== '/' || target?.closest('input, textarea, [contenteditable="true"]')) return
      e.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const projectName = new Map(projects.map((p) => [p.id, p.name]))
  // A filter on a since-removed project falls back to All rather than hiding everything.
  const filterProject = projects.find((p) => p.id === filter) ?? null
  const all: WorkspaceRow[] = Object.values(workspacesByProject)
    .flat()
    .filter((w) => !w.archived)
    .sort((a, b) => b.createdAt - a.createdAt)
  const q = query.trim().toLowerCase()
  const shown = all.filter(
    (w) =>
      (filterProject === null || w.projectId === filterProject.id) &&
      (q === '' || w.name.toLowerCase().includes(q) || w.branch.toLowerCase().includes(q))
  )

  function pickFilter(projectId: string | null) {
    setFilter(projectId)
    setFilterOpen(false)
  }

  return (
    <main className="main glass home">
      <div className="home-head">
        <label className="home-search">
          <span className="home-search-glyph" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
            }}
            placeholder="Search conversations…"
          />
          <span className="kbd">{query === '' ? '/' : 'esc'}</span>
        </label>
        <div className="home-filters">
          <div className="popover-wrap home-filter">
            <button
              ref={filterRef}
              type="button"
              className="dropdown-trigger"
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              aria-label="Project filter"
              onClick={() => setFilterOpen((open) => !open)}
            >
              <span className="grow">{filterProject?.name ?? 'All projects'}</span>
              <span className="dropdown-caret" aria-hidden="true" />
            </button>
            <Popover
              open={filterOpen}
              onClose={closeFilter}
              anchorRef={filterRef}
              align="right"
              className="home-filter-menu"
            >
              <button
                type="button"
                role="menuitem"
                className="list-option popover-item"
                onClick={() => pickFilter(null)}
              >
                <span className="grow">All projects</span>
                {filterProject === null && (
                  <span className="dropdown-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
              {projects.length > 0 && <div className="popover-sep" role="separator" />}
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className="list-option popover-item"
                  onClick={() => pickFilter(p.id)}
                >
                  <span className="grow home-filter-name">{p.name}</span>
                  {filterProject?.id === p.id && (
                    <span className="dropdown-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </Popover>
          </div>
        </div>
      </div>
      <div className="home-results">
        {shown.length > 0 && <div className="home-label">{q === '' ? 'Recent' : 'Results'}</div>}
        {shown.map((ws) => (
          <button key={ws.id} type="button" className="home-card" onClick={() => void resume(ws.id)}>
            <span className="grow home-card-name">{ws.name}</span>
            <span className="home-card-project">{projectName.get(ws.projectId) ?? 'Unknown project'}</span>
            <span className="home-time">{relativeTime(ws.createdAt)}</span>
          </button>
        ))}
        {all.length > 0 && shown.length === 0 && (
          <div className="home-none">
            <span className="muted">
              No conversations match {q === '' ? 'this filter' : `“${query.trim()}”`}.
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setQuery('')
                setFilter(null)
              }}
            >
              Clear filters
            </button>
          </div>
        )}
        {all.length === 0 && (
          <div className="empty-state">
            <WeaveMark />
            <div className="empty-title">Ready to Create Something New?</div>
            <div className="quick-chips">
              <button className="chip" onClick={() => startSomething('Summarize this repository.')}>
                Summarize repo
              </button>
              <button className="chip" onClick={() => startSomething('Plan a change: ')}>
                Plan a change
              </button>
              <button className="chip" onClick={() => startSomething('Review the current diff.')}>
                Review diff
              </button>
            </div>
            <div className="suggestion-grid">
              <button
                className="suggestion-card"
                onClick={() => startSomething('Generate clean, production-ready code for: ')}
              >
                <span className="tag-pill">code</span>
                <strong>Dev Assistant</strong>
                <span className="muted">Generate clean, production-ready code in seconds.</span>
              </button>
              <button
                className="suggestion-card"
                onClick={() => startSomething('Walk the worktree diff with me, file by file.')}
              >
                <span className="tag-pill">review</span>
                <strong>Review Helper</strong>
                <span className="muted">Walk a worktree diff with an agent, file by file.</span>
              </button>
              <button
                className="suggestion-card"
                onClick={() => startSomething('Turn this intention into a phased plan: ')}
              >
                <span className="tag-pill">plan</span>
                <strong>Plan Builder</strong>
                <span className="muted">Turn a fuzzy intention into a phased plan.</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
