import { useEffect, useState } from 'react'
import type { ProjectRow } from '../../../shared/ipc-contract'
import { useProjects } from '../../state/projects'
import { useUi } from '../../state/ui'
import { Modal } from '../ui/Modal'
import { useToasts } from '../ui/Toast'
import { tildePath } from './ProjectMenu'

/**
 * Confirms removing a project. Main deletes every workspace first (worktree, branch and sessions,
 * archived ones included) and then the project row. For repositories Loom cloned itself the user
 * may also tick away the cloned copy; adopted folders always stay on disk. Navigates home if the
 * current route belonged to the project.
 */
export function RemoveProjectModal({ project, onClose }: { project: ProjectRow; onClose: () => void }) {
  const workspaces = useProjects((s) => s.workspacesByProject[project.id]) ?? []
  const removeProject = useProjects((s) => s.removeProject)
  const push = useToasts((s) => s.push)
  const [busy, setBusy] = useState(false)
  const [owned, setOwned] = useState<boolean | null>(null)
  const [deleteRepo, setDeleteRepo] = useState(false)

  // Only clones and quick starts live under the app's repos dir; the checkbox means nothing
  // for an adopted folder, so it stays hidden until main says the repo is Loom's own.
  useEffect(() => {
    let live = true
    window.loom.projects
      .repoOwned(project.id)
      .then((value) => {
        if (live) setOwned(value)
      })
      .catch(() => {
        if (live) setOwned(false)
      })
    return () => {
      live = false
    }
  }, [project.id])

  async function confirm() {
    setBusy(true)
    // Read before removal: the store drops the project's workspaces once main confirms.
    const ownedIds = new Set(workspaces.map((w) => w.id))
    try {
      await removeProject(project.id, deleteRepo && owned === true)
    } catch (err) {
      push(`Could not remove ${project.name}: ${String(err)}`, 'err')
      setBusy(false)
      return
    }
    const { route, navigate } = useUi.getState()
    if (
      (route.name === 'workspace' && ownedIds.has(route.workspaceId)) ||
      (route.name === 'settings' && route.page === `project:${project.id}`)
    )
      navigate({ name: 'home' })
    push(`Removed ${project.name}`)
    onClose()
  }

  return (
    <Modal
      open
      title="Remove project"
      className="project-remove"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Removing…' : 'Delete workspaces and remove'}
          </button>
        </>
      }
    >
      {workspaces.length === 0 ? (
        <p className="ws-confirm">
          Remove <strong>{project.name}</strong> from Loom? It has no workspaces, so nothing else is deleted.
        </p>
      ) : (
        <>
          <p className="ws-confirm">
            Remove <strong>{project.name}</strong> from Loom? Its{' '}
            {workspaces.length === 1 ? 'workspace' : `${workspaces.length} workspaces`} will be deleted,
            including their worktrees and branches on disk, and their sessions:
          </p>
          <ul className="ws-confirm">
            {workspaces.map((w) => (
              <li key={w.id}>
                <strong>{w.name}</strong> <code className="md-code">{w.branch}</code>
                {w.archived && ' (archived)'}
              </li>
            ))}
          </ul>
        </>
      )}
      {owned === true ? (
        <label className="ws-check">
          <input type="checkbox" checked={deleteRepo} onChange={(e) => setDeleteRepo(e.target.checked)} />
          <span>
            Also delete the cloned repository folder{' '}
            <code className="md-code">{tildePath(project.repoPath)}</code> from disk. Unpushed commits inside
            it will be lost.
          </span>
        </label>
      ) : (
        <p className="ws-confirm">
          The repository folder <code className="md-code">{project.repoPath}</code> is left on disk.
        </p>
      )}
    </Modal>
  )
}
