import { NewWorkspaceForm } from './NewWorkspaceForm'

/** The same workspace form is hosted in the modal and on Home. */
export function NewWorkspaceModal(props: {
  projectId: string | null
  projectMenu?: boolean
  initialLocation?: 'mac' | 'cloud'
}) {
  return <NewWorkspaceForm {...props} />
}
