import { InstructionsEditor } from './InstructionsEditor'

/** Settings "Instructions": instance-wide markdown appended to every agent session. */
export function InstructionsPage() {
  return (
    <InstructionsEditor
      scope="instance"
      projectId={null}
      label="Instance instructions"
      hint="Markdown appended to every agent session on this machine, whatever the project."
    />
  )
}
