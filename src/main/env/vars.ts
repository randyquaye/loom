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

export function envKey(scope: EnvScope, projectId: string | null, name: string): string {
  return scope === 'global' ? `env::global::${name}` : `env::project::${projectId}::${name}`
}

function prefixFor(scope: EnvScope, projectId: string | null): string {
  if (scope === 'global') return 'env::global::'
  if (projectId === null) throw new EnvNameRejectedError('project scope needs a project id')
  return `env::project::${projectId}::`
}

export function assertEnvName(name: string): void {
  if (!NAME_RE.test(name)) throw new EnvNameRejectedError(`"${name}" is not a shell identifier`)
  if (name.startsWith('LOOM_')) throw new EnvNameRejectedError('LOOM_ is reserved for Loom itself')
  if (RESERVED.has(name)) throw new EnvNameRejectedError(`${name} is reserved by the process`)
}

export async function listEnvVars(scope: EnvScope, projectId: string | null = null): Promise<EnvVarRow[]> {
  const prefix = prefixFor(scope, projectId)
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
  value: string
): Promise<void> {
  assertEnvName(name)
  await secrets().setRaw(envKey(scope, projectId, name), value)
}

export async function deleteEnvVar(scope: EnvScope, projectId: string | null, name: string): Promise<void> {
  await secrets().deleteRaw(envKey(scope, projectId, name))
}

/** Global first, then project overriding same-named entries; decrypted for injection only. */
export async function envOverlay(projectId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const scope of ['global', 'project'] as const) {
    for (const row of await listEnvVars(scope, projectId)) {
      const value = await secrets().getRaw(envKey(scope, projectId, row.name))
      if (value !== null) out[row.name] = value
    }
  }
  return out
}

/** Names only, for prompts and context files: values never leave the process environment. */
export async function envNames(projectId: string): Promise<string[]> {
  return Object.keys(await envOverlay(projectId)).sort()
}
