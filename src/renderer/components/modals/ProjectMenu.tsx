import { useCallback, useState } from 'react'
import type { ProjectRow } from '../../../shared/ipc-contract'
import { useProjects } from '../../state/projects'
import { FolderIcon, FolderPlusIcon, GlobeIcon } from '../ui/icons'
import { Popover } from '../ui/Popover'
import { useToasts } from '../ui/Toast'
import { QuickStartModal } from './QuickStartModal'
import './project-menu.css'

/** /Users/<me>/x → ~/x; the renderer has no $HOME, but repo paths always sit under it on macOS. */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~')
}

function basename(path: string): string {
  return (
    path
      .split('/')
      .filter((part) => part !== '')
      .pop() ?? path
  )
}

/**
 * Conductor-style project menu anchored under the New Workspace project picker: open a local
 * folder, clone from GitHub, quick-start a named empty repo, or jump to a recent project.
 */
export function ProjectMenu({
  open,
  onClose,
  onPick,
  onClone
}: {
  open: boolean
  onClose: () => void
  onPick: (projectId: string) => void
  onClone: () => void
}) {
  const projects = useProjects((s) => s.projects)
  const addProject = useProjects((s) => s.addProject)
  const push = useToasts((s) => s.push)
  const [busy, setBusy] = useState(false)
  const [naming, setNaming] = useState(false)
  // Stable identity: Modal re-runs its autofocus whenever onClose changes.
  const closeNaming = useCallback(() => setNaming(false), [])
  const recents = [...projects].sort((a, b) => b.createdAt - a.createdAt)

  /** Failures toast and leave the menu open so the user can try another source. */
  async function acquire(task: () => Promise<ProjectRow | null>, failure: string) {
    if (busy) return
    setBusy(true)
    try {
      const project = await task()
      if (project !== null) onPick(project.id)
    } catch (err) {
      push(`${failure}: ${String(err)}`, 'err')
    } finally {
      setBusy(false)
    }
  }

  const openFolder = () =>
    acquire(async () => {
      const path = await window.loom.projects.pickFolder()
      if (path === null) return null
      return addProject({ name: basename(path).slice(0, 64), source: { kind: 'local', path } })
    }, 'Could not open project')

  function startEmpty() {
    onClose()
    setNaming(true)
  }

  return (
    <>
      <Popover open={open} onClose={onClose} className="pm-menu">
        <button
          type="button"
          role="menuitem"
          className="list-option popover-item"
          disabled={busy}
          onClick={() => void openFolder()}
        >
          <FolderIcon />
          <span className="grow">Open project</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="list-option popover-item"
          disabled={busy}
          onClick={onClone}
        >
          <GlobeIcon />
          <span className="grow">Open GitHub project</span>
        </button>
        <button
          type="button"
          role="menuitem"
          className="list-option popover-item"
          disabled={busy}
          onClick={startEmpty}
        >
          <FolderPlusIcon />
          <span className="grow">Quick start</span>
        </button>
        {recents.length > 0 && (
          <>
            <div className="popover-sep" role="separator" />
            <div className="popover-label" role="presentation">
              Recents
            </div>
            <div className="pm-recents" role="group" aria-label="Recent projects">
              {recents.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className="list-option popover-item"
                  title={p.repoPath}
                  onClick={() => onPick(p.id)}
                >
                  <FolderIcon />
                  <span className="grow pm-path">{tildePath(p.repoPath)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </Popover>
      {naming && (
        <QuickStartModal
          onClose={closeNaming}
          onCreated={(project) => {
            setNaming(false)
            onPick(project.id)
          }}
        />
      )}
    </>
  )
}
