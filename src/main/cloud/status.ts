import type { CloudStatus } from '../../shared/ipc-contract'
import type { CloudAccount } from './account'

let current: CloudStatus = { state: 'off' }

/** `off` until a runner is configured; local Loom never leaves that state. */
export function cloudStatus(): CloudStatus {
  return current
}

/** Kept here, apart from the route, so the window can ask before any change is pushed. */
export function setCloudStatus(next: CloudStatus): void {
  current = next
}

let account: CloudAccount | null = null

/** The desktop opens its account once, at startup; a runner process never has one. */
export function setCloudAccount(next: CloudAccount): void {
  account = next
}

export function cloudAccount(): CloudAccount {
  if (account === null) throw new Error('Cloud settings are not available')
  return account
}
