import { useState } from 'react'
import type { WorkspaceRow } from '../../../shared/ipc-contract'
import { useProjects } from '../../state/projects'
import { useUi } from '../../state/ui'
import { Modal } from '../ui/Modal'
import { useToasts } from '../ui/Toast'

/** Confirms removal of a workspace's worktree, branch and sessions; navigates home if it was open. */
export function DeleteWorkspaceModal({
  workspace,
  onClose
}: {
  workspace: WorkspaceRow
  onClose: () => void
}) {
  const removeWorkspace = useProjects((s) => s.removeWorkspace)
  const push = useToasts((s) => s.push)
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    try {
      await removeWorkspace(workspace.id)
    } catch (err) {
      push(`Could not delete ${workspace.name}: ${String(err)}`, 'err')
      setBusy(false)
      return
    }
    const { route, navigate } = useUi.getState()
    if (route.name === 'workspace' && route.workspaceId === workspace.id) navigate({ name: 'home' })
    push(`Deleted ${workspace.name}`)
    onClose()
  }

  return (
    <Modal
      open
      title="Delete workspace"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Deleting…' : 'Delete workspace'}
          </button>
        </>
      }
    >
      <p className="ws-confirm">
        Delete <strong>{workspace.name}</strong>? Its worktree and branch{' '}
        <code className="md-code">{workspace.branch}</code> will be removed and its sessions deleted.
      </p>
    </Modal>
  )
}
