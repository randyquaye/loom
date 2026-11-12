import { useCloud } from '../../state/cloud'
import { EnvVarList } from './EnvVarList'

/** Settings "Environment": instance-wide variables injected into every agent process. */
export function EnvPage() {
  // Cloud values live on the runner, so they can only be shown while it can be asked.
  const cloud = useCloud((s) => s.status.state === 'connected')
  return (
    <>
      <EnvVarList
        scope="global"
        projectId={null}
        intro="Injected into every agent session, terminal and run action on this machine. Values are stored encrypted; agents are told the names but never the values."
      />
      {cloud && (
        <EnvVarList
          cloud
          scope="global"
          projectId={null}
          intro="Injected into every agent session, terminal and run action in your cloud workspaces. Kept on the cloud host, apart from this Mac's values; nobody else on the host can read them."
        />
      )}
    </>
  )
}
