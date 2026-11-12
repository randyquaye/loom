import type { EnvScope, EnvVarRow } from '../../shared/ipc-contract'
import { maskSecret, type SecretStore } from '../secrets'

export type { EnvScope, EnvVarRow }

export class EnvNameRejectedError extends Error {
  readonly code = 'ENV_NAME_REJECTED'

  constructor(detail: string) {
    super(`ENV_NAME_REJECTED: ${detail}`)
    this.name = 'EnvNameRejectedError'
  }
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/**
 * Names the app or the process itself owns. A user variable shadowing one of these would
 * silently change how every agent, terminal and setup script behaves, so it is refused.
 */
const RESERVED = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TERM',
  'LANG',
  'LC_ALL',
  'PWD',
  'OLDPWD',
  'SHLVL',
  '_'
])

let store: SecretStore | null = null

/** Wired by main once the secret store exists; values live encrypted beside the API keys. */
export function setEnvSecretStore(next: SecretStore): void {
  store = next
}

function secrets(): SecretStore {
  if (store === null) throw new Error('the env secret store is not wired')
  return store
}

/**
 * Whose values these are. Null on the desktop, where everything belongs to the one user of
 * the Mac. On a runner a project is only a repository's address that several people share,
 * so every value is kept under the person who set it and is read for nobody else.
 */
export type EnvOwner = string | null

function prefixFor(scope: EnvScope, projectId: string | null, owner: EnvOwner): string {
  const mine = owner === null ? '' : `user::${owner}::`
  if (scope === 'global') return `${mine}env::global::`
  if (projectId === null) throw new EnvNameRejectedError('project scope needs a project id')
  return `${mine}env::project::${projectId}::`
}

export function envKey(
  scope: EnvScope,
  projectId: string | null,
  name: string,
  owner: EnvOwner = null
): string {
  return `${prefixFor(scope, projectId, owner)}${name}`
}

export function assertEnvName(name: string): void {
  if (!NAME_RE.test(name)) throw new EnvNameRejectedError(`"${name}" is not a shell identifier`)
  if (name.startsWith('LOOM_')) throw new EnvNameRejectedError('LOOM_ is reserved for Loom itself')
  if (RESERVED.has(name)) throw new EnvNameRejectedError(`${name} is reserved by the process`)
}

export async function listEnvVars(
  scope: EnvScope,
  projectId: string | null = null,
  owner: EnvOwner = null
): Promise<EnvVarRow[]> {
  const prefix = prefixFor(scope, projectId, owner)
  const rows: EnvVarRow[] = []
  for (const key of await secrets().listRaw(prefix)) {
    const value = await secrets().getRaw(key)
    if (value === null) continue
    rows.push({ name: key.slice(prefix.length), masked: maskSecret(value) })
  }
  return rows
}

export async function setEnvVar(
  scope: EnvScope,
  projectId: string | null,
  name: string,
  value: string,
  owner: EnvOwner = null
): Promise<void> {
  assertEnvName(name)
  await secrets().setRaw(envKey(scope, projectId, name, owner), value)
}

export async function deleteEnvVar(
  scope: EnvScope,
  projectId: string | null,
  name: string,
  owner: EnvOwner = null
): Promise<void> {
  await secrets().deleteRaw(envKey(scope, projectId, name, owner))
}

/** Global first, then project overriding same-named entries; decrypted for injection only. */
export async function envOverlay(projectId: string, owner: EnvOwner = null): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const scope of ['global', 'project'] as const) {
    for (const row of await listEnvVars(scope, projectId, owner)) {
      const value = await secrets().getRaw(envKey(scope, projectId, row.name, owner))
      if (value !== null) out[row.name] = value
    }
  }
  return out
}

/** Names only, for prompts and context files: values never leave the process environment. */
export async function envNames(projectId: string, owner: EnvOwner = null): Promise<string[]> {
  return Object.keys(await envOverlay(projectId, owner)).sort()
}
