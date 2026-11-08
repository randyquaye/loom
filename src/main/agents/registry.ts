import type { AuthStatus, BackendId } from '../../shared/models'
import type { AgentBackend } from './types'

const backends = new Map<BackendId, AgentBackend>()

/** Backends register themselves at startup wiring; the session service resolves them by id. */
export function registerBackend(backend: AgentBackend): void {
  backends.set(backend.id, backend)
}

export function getBackend(id: BackendId): AgentBackend | undefined {
  return backends.get(id)
}

/**
 * Wiring registers all four backends before the window opens, so each backend's
 * own authStatus is authoritative; an unregistered id is a startup bug, not a
 * user-facing auth state.
 */
export async function authStatusFor(backend: BackendId): Promise<AuthStatus> {
  const registered = backends.get(backend)
  if (registered !== undefined) return registered.authStatus()
  return { state: 'error', message: `backend ${backend} is not registered` }
}
