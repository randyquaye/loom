export const UPDATE_STATUS_CHANNEL = 'updates:changed'

export type DesktopUpdateStatus = { currentVersion: string } & (
  | { state: 'unavailable' | 'idle' | 'checking' }
  | { state: 'available' | 'ready'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'error'; message: string }
)
