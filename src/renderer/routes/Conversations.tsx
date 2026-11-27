import { useCallback, useEffect, useRef, useState } from 'react'
import { SearchIcon } from '../components/ui/icons'
import { Popover } from '../components/ui/Popover'
import { useProjects } from '../state/projects'
import { useUi } from '../state/ui'
import { ConversationList } from './ConversationList'
import './home.css'

const PAGE_SIZE = 20

export function Conversations() {
  const projects = useProjects((s) => s.projects)
  const workspacesByProject = useProjects((s) => s.workspacesByProject)
  const navigate = useUi((s) => s.navigate)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<string | null>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [page, setPage] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const filterRef = useRef<HTMLButtonElement>(null)
  const closeFilter = useCallback(() => setFilterOpen(false), [])

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== '/' || target?.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const filterProject = projects.find((project) => project.id === filter) ?? null
  const q = query.trim().toLowerCase()
  const all = Object.values(workspacesByProject)
    .flat()
    .filter((workspace) => !workspace.archived)
    .sort((a, b) => b.createdAt - a.createdAt)
  const shown = all.filter(
    (workspace) =>
      (filterProject === null || workspace.projectId === filterProject.id) &&
      (q === '' || workspace.name.toLowerCase().includes(q) || workspace.branch.toLowerCase().includes(q))
  )
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const offset = currentPage * PAGE_SIZE

  function pickFilter(projectId: string | null) {
    setFilter(projectId)
    setPage(0)
    closeFilter()
  }

  return (
    <main className="main home conversations">
      <header className="conversations-title">
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="Back to home"
          onClick={() => navigate({ name: 'home' })}
        >
          <span aria-hidden="true">←</span> Home
        </button>
        <h1>All conversations</h1>
      </header>
      <div className="home-head">
        <label className="home-search">
          <SearchIcon />
          <input
            ref={inputRef}
            aria-label="Search conversations"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery('')
                setPage(0)
              }
            }}
            placeholder="Search conversations…"
          />
          <span className="kbd">{query === '' ? '/' : 'esc'}</span>
        </label>
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
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                role="menuitem"
                className="list-option popover-item"
                onClick={() => pickFilter(project.id)}
              >
                <span className="grow home-filter-name">{project.name}</span>
                {filterProject?.id === project.id && (
                  <span className="dropdown-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </Popover>
        </div>
      </div>
      <div className="home-results">
        <ConversationList workspaces={shown.slice(offset, offset + PAGE_SIZE)} />
        {shown.length === 0 && (
          <div className="home-none">
            <span className="muted">
              {all.length === 0
                ? 'No conversations yet. Start something from Home.'
                : `No conversations match ${q === '' ? 'this filter' : `“${query.trim()}”`}.`}
            </span>
            {all.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setQuery('')
                  pickFilter(null)
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>
      {shown.length > 0 && (
        <nav className="conversations-pagination" aria-label="Conversation pages">
          <span aria-live="polite">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, shown.length)} of {shown.length} conversations
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-ghost"
            aria-label="Previous page"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            ← Previous
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            aria-label="Next page"
            disabled={currentPage === pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            Next →
          </button>
        </nav>
      )}
    </main>
  )
}
