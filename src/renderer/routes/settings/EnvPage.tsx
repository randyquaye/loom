import { EnvVarList } from './EnvVarList'

/** Settings "Environment": instance-wide variables injected into every agent process. */
export function EnvPage() {
  return (
    <EnvVarList
      scope="global"
      projectId={null}
      intro="Injected into every agent session, terminal and run action on this machine. Values are stored encrypted; agents are told the names but never the values."
    />
  )
}
