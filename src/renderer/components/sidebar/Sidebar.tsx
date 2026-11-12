import { useCloud } from '../../state/cloud'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BranchPrState, ProjectRow, WorkspaceRow } from '../../../shared/ipc-contract'
import { MAX_WORKSPACES_PER_PROJECT } from '../../../shared/limits'
import { useProjects } from '../../state/projects'
import { useUi } from '../../state/ui'
import { RemoveProjectModal } from '../modals/RemoveProjectModal'
import { CloudStatusLine } from './CloudStatusLine'
import { DeleteWorkspaceModal } from './DeleteWorkspaceModal'
import { SettingsNav } from './SettingsNav'
import { RowMenu, WorkspaceItem } from './WorkspaceItem'
import './sidebar.css'

/** Archived workspaces are parked: they neither show by default nor count toward the cap. */
const liveCount = (list: WorkspaceRow[] | undefined) => (list ?? []).filter((w) => !w.archived).length

/** A project row's "⋯" trigger and its portalled actions menu. */
function ProjectActions({ project, onRemove }: { project: ProjectRow; onRemove: () => void }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn row-action"
        title="Project actions"
        aria-label={`Actions for ${project.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) close()
          else setOpen(true)
        }}
      >
        ⋯
      </button>
      {open && (
        <RowMenu anchorRef={triggerRef} onClose={close} className="ws-menu">
          <button
            type="button"
            role="menuitem"
            className="list-option popover-item popover-item-danger"
            onClick={() => {
              close()
              onRemove()
            }}
          >
            Remove project…
          </button>
        </RowMenu>
      )}
    </>
  )
}

/** gh is a subprocess per call, so badges refresh on a slow poll and when the window regains focus. */
const PR_POLL_MS = 60_000

/**
 * Open/merged PR per head branch, per project: one `gh pr list` per project rather than one per
 * workspace. Projects without a GitHub remote, or without gh, simply show plain branch icons.
 */
function useBranchPrs(
  targets: Array<{ projectId: string; cloud: boolean }>
): Record<string, Record<string, BranchPrState>> {
  const [byProject, setByProject] = useState<Record<string, Record<string, BranchPrState>>>({})
  const key = JSON.stringify(targets)
  const cloudState = useCloud((state) => state.status.state)
  useEffect(() => {
    let active = true
    const ids = JSON.parse(key) as Array<{ projectId: string; cloud: boolean }>
    const refresh = () => {
      void Promise.all(
        ids.map(async ({ projectId, cloud }) => {
          const result =
            cloud && cloudState !== 'connected'
              ? null
              : await window.loom.github.branchPrs(projectId, cloud).catch(() => null)
          return [
            `${projectId}:${cloud ? 'cloud' : 'mac'}`,
            result?.kind === 'ok' ? result.byBranch : {}
          ] as const
        })
      ).then((entries) => {
        if (active) setByProject(Object.fromEntries(entries))
      })
    }
    refresh()
    const timer = setInterval(refresh, PR_POLL_MS)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [key, cloudState])
  return byProject
}

export function Sidebar() {
  const { projects, workspacesByProject, error, load } = useProjects()
  // Provider detail lives in Settings; the sidebar only signals that something needs attention.
  const needsSetup = useProjects((s) => Object.values(s.statusByProvider).filter((v) => v !== 'ready').length)
  const settingsHint =
    needsSetup > 0 ? `${needsSetup} provider(s) need setup` : 'Providers, keys and default models'
  const route = useUi((s) => s.route)
  const navigate = useUi((s) => s.navigate)
  const leaveSettings = useUi((s) => s.leaveSettings)
  const openAddProject = useUi((s) => s.openAddProject)
  const openAddWorkspace = useUi((s) => s.openAddWorkspace)
  const openPalette = useUi((s) => s.openPalette)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [showArchived, setShowArchived] = useState<ReadonlySet<string>>(new Set())
  const [deleting, setDeleting] = useState<WorkspaceRow | null>(null)
  // Stable identity: Modal re-runs its autofocus whenever onClose changes.
  const closeDelete = useCallback(() => setDeleting(null), [])
  const [removing, setRemoving] = useState<ProjectRow | null>(null)
  const closeRemove = useCallback(() => setRemoving(null), [])
  const prsByProject = useBranchPrs(
    projects.flatMap((project) => {
      const workspaces = workspacesByProject[project.id] ?? []
      return [false, true]
        .filter((cloud) => workspaces.some((workspace) => Boolean(workspace.cloud) === cloud))
        .map((cloud) => ({ projectId: project.id, cloud }))
    })
  )

  // Stored as the collapsed set so every project, including newly added ones, starts expanded.
  const toggleCollapsed = (projectId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(projectId)) next.add(projectId)
      return next
    })

  const toggleArchived = (projectId: string) =>
    setShowArchived((prev) => {
      const next = new Set(prev)
      if (!next.delete(projectId)) next.add(projectId)
      return next
    })

  useEffect(() => {
    void load()
  }, [load])

  const activeWorkspaceId = route.name === 'workspace' ? route.workspaceId : null
  const selectedProjectId =
    activeWorkspaceId === null
      ? null
      : (Object.values(workspacesByProject)
          .flat()
          .find((w) => w.id === activeWorkspaceId)?.projectId ?? null)
  const selectedAtCap =
    selectedProjectId !== null &&
    liveCount(workspacesByProject[selectedProjectId]) >= MAX_WORKSPACES_PER_PROJECT

  return (
    <>
      <aside className="sidebar glass">
        <nav className="side-nav" aria-label="Primary">
          <button
            type="button"
            className="side-foot-btn"
            disabled={selectedAtCap}
            title={selectedAtCap ? 'Workspace limit reached' : 'New workspace'}
            onClick={() => openAddWorkspace(selectedProjectId)}
          >
            <span className="side-foot-glyph" aria-hidden="true">
              +
            </span>
            <span className="grow">New</span>
          </button>
          <button
            type="button"
            className="side-foot-btn"
            data-active={route.name === 'home'}
            aria-current={route.name === 'home' ? 'page' : undefined}
            onClick={() => navigate({ name: 'home' })}
          >
            <span className="side-foot-glyph" aria-hidden="true">
              ⌂
            </span>
            <span className="grow">Home</span>
          </button>
          <button type="button" className="side-foot-btn" title="Search" onClick={openPalette}>
            <span className="side-foot-glyph" aria-hidden="true">
              ⌕
            </span>
            <span className="grow">Search</span>
          </button>
        </nav>

        <div className="side-scroll">
          {route.name === 'settings' ? (
            <SettingsNav />
          ) : (
            <>
              <div className="section-head">
                <span className="section-label grow">Projects</span>
                <button
                  className="icon-btn"
                  title="New project"
                  aria-label="New project"
                  onClick={openAddProject}
                >
                  +
                </button>
              </div>
              {projects.map((project) => {
                const workspaces = workspacesByProject[project.id] ?? []
                const live = workspaces.filter((w) => !w.archived)
                const archived = workspaces.filter((w) => w.archived)
                const archivedOpen = showArchived.has(project.id)
                const atCap = live.length >= MAX_WORKSPACES_PER_PROJECT
                const expanded = !collapsed.has(project.id)
                return (
                  <div key={project.id} className="project-block">
                    <div className="project-row" data-selected={project.id === selectedProjectId}>
                      <button
                        type="button"
                        className="project-toggle"
                        aria-expanded={expanded}
                        title={expanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
                        onClick={() => toggleCollapsed(project.id)}
                      >
                        <span className="project-lead" aria-hidden="true">
                          <span className="project-glyph">{project.name.slice(0, 1).toUpperCase()}</span>
                          <span className="dropdown-caret" />
                        </span>
                        <span className="project-name">{project.name}</span>
                      </button>
                      <button
                        className="icon-btn row-action"
                        title={atCap ? 'Workspace limit reached' : 'New workspace'}
                        aria-label={`New workspace in ${project.name}`}
                        disabled={atCap}
                        onClick={() => openAddWorkspace(project.id)}
                      >
                        +
                      </button>
                      <ProjectActions project={project} onRemove={() => setRemoving(project)} />
                    </div>
                    <div className="project-workspaces" data-collapsed={!expanded}>
                      <div className="project-workspaces-inner">
                        {live.map((ws) => (
                          <WorkspaceItem
                            key={ws.id}
                            workspace={ws}
                            active={ws.id === activeWorkspaceId}
                            pr={prsByProject[`${project.id}:${ws.cloud ? 'cloud' : 'mac'}`]?.[ws.branch]}
                            onDelete={() => setDeleting(ws)}
                          />
                        ))}
                      </div>
                    </div>
                    {archived.length > 0 && (
                      <button
                        type="button"
                        className="section-label ws-archived-toggle"
                        aria-expanded={archivedOpen}
                        onClick={() => toggleArchived(project.id)}
                      >
                        <span className="dropdown-caret" aria-hidden="true" />
                        <span className="grow">Archived</span>
                        <span className="ws-archived-count">{archived.length}</span>
                      </button>
                    )}
                    {archivedOpen &&
                      archived.map((ws) => (
                        <WorkspaceItem
                          key={ws.id}
                          workspace={ws}
                          active={ws.id === activeWorkspaceId}
                          pr={prsByProject[`${project.id}:${ws.cloud ? 'cloud' : 'mac'}`]?.[ws.branch]}
                          onDelete={() => setDeleting(ws)}
                        />
                      ))}
                  </div>
                )
              })}
              {projects.length === 0 && (
                <div className="side-empty">No projects yet. Add a git repository to begin.</div>
              )}
              {error && <div className="side-empty side-error">{error}</div>}
            </>
          )}
        </div>

        <CloudStatusLine />
        <div className="side-foot">
          <button
            className="side-foot-btn"
            data-active={route.name === 'settings'}
            aria-current={route.name === 'settings' ? 'page' : undefined}
            title={settingsHint}
            onClick={() => (route.name === 'settings' ? leaveSettings() : navigate({ name: 'settings' }))}
          >
            <span className="side-foot-glyph" aria-hidden="true">
              ⚙
            </span>
            <span className="grow">Settings</span>
            {needsSetup > 0 && <span className="side-foot-dot" aria-hidden="true" />}
          </button>
        </div>
      </aside>
      {/* Outside the aside: its backdrop-filter would contain the modal's fixed overlay. */}
      {deleting !== null && <DeleteWorkspaceModal workspace={deleting} onClose={closeDelete} />}
      {removing !== null && <RemoveProjectModal project={removing} onClose={closeRemove} />}
    </>
  )
}
