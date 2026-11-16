import type { DesktopUpdater } from '../updates/service'
import { handle } from './registry'

export function registerUpdatesIpc(updates?: DesktopUpdater): void {
  const unavailable = (): never => {
    throw new Error('Automatic updates are unavailable in this build')
  }
  handle('updates:status', () => updates?.status() ?? { state: 'unavailable', currentVersion: '' })
  handle('updates:check', () => (updates === undefined ? unavailable() : updates.check()))
  handle('updates:download', () => (updates === undefined ? unavailable() : updates.download()))
  handle('updates:install', () => (updates === undefined ? unavailable() : updates.install()))
}
