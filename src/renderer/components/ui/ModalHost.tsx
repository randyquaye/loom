import { useUi } from '../../state/ui'
import { NewWorkspaceModal } from '../modals/NewWorkspaceModal'

/** Mounts each modal only while its flag is set, so form state resets on every open. */
export function ModalHost() {
  const modals = useUi((s) => s.modals)
  // Every "new workspace" and "new project" entry point (sidebar, per-project +, palette) lands here.
  if (modals.addWorkspaceFor !== null)
    return (
      <NewWorkspaceModal
        projectId={modals.addWorkspaceFor === '' ? null : modals.addWorkspaceFor}
        projectMenu={modals.projectMenu}
      />
    )
  return null
}
