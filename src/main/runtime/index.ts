import path from 'node:path'
import type { WorkspaceRow } from '../../shared/ipc-contract'
import {
  containerAddresses,
  createContainerRuntime,
  removeContainer,
  removeContainersNamed
} from './container'
import { machineRuntime } from './machine'
import type { WorkspaceRuntime } from './types'

export type { RuntimeProcess, RuntimeTerminal, WorkspaceRuntime } from './types'
export { machineRuntime } from './machine'

/** Under the data folder: one home folder per user, named by their id. */
export const HOMES_DIR = 'homes'
/** The home of a workspace with no owner: this Mac's one user. */
const LOCAL_USER = 'local'

/**
 * One home folder per user, shared by all of that user's containers and by nobody else's:
 * agent logins live in it. The id becomes a folder name, so it may not be a path.
 */
export function homeFolder(dataRoot: string, ownerId: string | null): string {
  const user = ownerId ?? LOCAL_USER
  if (!/^[A-Za-z0-9_-]+$/.test(user)) throw new Error(`"${user}" cannot name a home folder`)
  return path.join(dataRoot, HOMES_DIR, user)
}

const CONTAINER_PREFIX = 'loom-ws-'

export function containerName(workspaceId: string): string {
  return `${CONTAINER_PREFIX}${workspaceId}`
}

/** The workspace whose container is at each address on the Docker networks right now. */
export async function workspacesByAddress(): Promise<Map<string, string>> {
  const byAddress = new Map<string, string>()
  for (const [address, name] of await containerAddresses(CONTAINER_PREFIX)) {
    byAddress.set(address, name.slice(CONTAINER_PREFIX.length))
  }
  return byAddress
}

/** What a runner that keeps its users' agent logins puts into their containers instead. */
export interface ContainerLogins {
  hosts: readonly string[]
  environment(ownerId: string): Promise<Record<string, string>>
  secureHome(ownerId: string, homePath: string): Promise<void>
}

let logins: ContainerLogins | null = null

/** Wired by such a runner before any container starts. Elsewhere logins stay in the home folder. */
export function setContainerLogins(next: ContainerLogins | null): void {
  logins = next
}

/**
 * Variables that stand in for a person's logins inside their container. They go in last, so
 * nothing the person set under the same name can point an agent away from the proxy.
 */
export async function loginEnvironment(
  workspace: Pick<WorkspaceRow, 'runtime' | 'ownerId'>
): Promise<Record<string, string>> {
  if (logins === null || workspace.runtime !== 'container' || workspace.ownerId === null) return {}
  return logins.environment(workspace.ownerId)
}

const SIGN_IN_PREFIX = 'loom-signin-'

/** Sign-in containers a previous runner process left behind, when it stopped in the middle of one. */
export function removeSignInContainers(): Promise<void> {
  return removeContainersNamed(SIGN_IN_PREFIX)
}

/**
 * A container for a sign-in program: the workspace image and a home of its own. It is no
 * workspace: nothing of anyone's checkout or home is in it, and the login proxy, which knows
 * workspaces by their names, gives it nothing.
 */
export function signInRuntime(dataRoot: string, id: string, homePath: string): WorkspaceRuntime {
  const apparmorProfile = process.env['LOOM_WORKSPACE_APPARMOR']
  return createContainerRuntime({
    name: `${SIGN_IN_PREFIX}${id}`,
    image: process.env['LOOM_WORKSPACE_IMAGE'] ?? 'loom-workspace:latest',
    checkoutPath: homePath,
    homePath,
    seccompProfilePath: path.join(dataRoot, 'workspace-seccomp.json'),
    memory: '1g',
    cpus: '1',
    ...(apparmorProfile === undefined || apparmorProfile === '' ? {} : { apparmorProfile })
  })
}

/** One runtime per container workspace, so concurrent starts share a single queue. */
const containers = new Map<string, WorkspaceRuntime>()

/** The runtime a workspace's agents, terminals and setup script start through. */
export function runtimeFor(
  workspace: Pick<WorkspaceRow, 'id' | 'runtime' | 'worktreePath' | 'ownerId'>,
  dataRoot: string | null
): WorkspaceRuntime {
  if (workspace.runtime !== 'container') return machineRuntime
  const existing = containers.get(workspace.id)
  if (existing !== undefined) return existing
  if (dataRoot === null) throw new Error('a container workspace needs the data root to place its home folder')
  const apparmorProfile = process.env['LOOM_WORKSPACE_APPARMOR']
  const kept = logins
  const owner = workspace.ownerId
  const runtime = createContainerRuntime({
    name: containerName(workspace.id),
    image: process.env['LOOM_WORKSPACE_IMAGE'] ?? 'loom-workspace:latest',
    checkoutPath: workspace.worktreePath,
    homePath: homeFolder(dataRoot, workspace.ownerId),
    seccompProfilePath: path.join(dataRoot, 'workspace-seccomp.json'),
    memory: process.env['LOOM_WORKSPACE_MEMORY'] ?? '4g',
    cpus: process.env['LOOM_WORKSPACE_CPUS'] ?? '2',
    ...(apparmorProfile === undefined || apparmorProfile === '' ? {} : { apparmorProfile }),
    ...(kept === null || owner === null
      ? {}
      : {
          hosts: kept.hosts,
          loginFilesPath: path.join(dataRoot, 'login-files', owner),
          secureHome: (homePath: string) => kept.secureHome(owner, homePath)
        })
  })
  containers.set(workspace.id, runtime)
  return runtime
}

/** Removes a workspace's container whether or not this process is the one that started it. */
export async function discardRuntime(workspace: Pick<WorkspaceRow, 'id' | 'runtime'>): Promise<void> {
  if (workspace.runtime !== 'container') return
  const known = containers.get(workspace.id)
  containers.delete(workspace.id)
  // Through the runtime when there is one, so the removal waits its turn behind a start.
  await (known === undefined ? removeContainer(containerName(workspace.id)) : known.stop())
}
