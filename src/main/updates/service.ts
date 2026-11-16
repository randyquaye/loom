import type { AppUpdater } from 'electron-updater'
import type { DesktopUpdateStatus } from '../../shared/desktop-updates'

export type NativeUpdater = Pick<
  AppUpdater,
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'allowDowngrade'
  | 'allowPrerelease'
  | 'on'
  | 'removeListener'
  | 'checkForUpdates'
  | 'downloadUpdate'
>

interface Options {
  updater: NativeUpdater | null
  currentVersion: string
  changed(status: DesktopUpdateStatus): void
  confirmInstall(): Promise<boolean>
  install(): Promise<void>
}

/** The native updater owns verification and replacement; Loom owns the user's consent. */
export function createDesktopUpdater({ updater, currentVersion, changed, confirmInstall, install }: Options) {
  let status: DesktopUpdateStatus = { currentVersion, state: updater === null ? 'unavailable' : 'idle' }
  let confirming = false
  let closed = false

  function publish(next: DesktopUpdateStatus): void {
    if (closed) return
    status = next
    changed(next)
  }
  function failed(error: Error): void {
    publish({ state: 'error', currentVersion, message: error.message })
  }
  function available(info: { version: string }): void {
    if (status.state === 'checking') publish({ state: 'available', currentVersion, version: info.version })
  }
  function notAvailable(): void {
    if (status.state === 'checking') publish({ state: 'idle', currentVersion })
  }
  function progress(info: { percent: number }): void {
    if (status.state !== 'downloading' || !Number.isFinite(info.percent)) return
    publish({ ...status, percent: Math.min(100, Math.max(0, info.percent)) })
  }
  function downloaded(info: { version: string }): void {
    if (status.state === 'downloading' && status.version === info.version) {
      publish({ state: 'ready', currentVersion, version: info.version })
    }
  }
  if (updater !== null) {
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.on('update-available', available)
    updater.on('update-not-available', notAvailable)
    updater.on('download-progress', progress)
    updater.on('update-downloaded', downloaded)
    updater.on('error', failed)
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action()
    } catch (error) {
      failed(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  return {
    status: () => status,
    async check(): Promise<void> {
      if (closed || updater === null) throw new Error('Automatic updates are unavailable in this build')
      if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return
      publish({ state: 'checking', currentVersion })
      await run(() => updater.checkForUpdates())
    },
    async download(): Promise<void> {
      if (closed || updater === null || status.state !== 'available') {
        throw new Error('No update is available to download')
      }
      publish({ state: 'downloading', currentVersion, version: status.version, percent: 0 })
      await run(() => updater.downloadUpdate())
    },
    async install(): Promise<void> {
      if (closed || updater === null || status.state !== 'ready') {
        throw new Error('Download and verify an update before installing it')
      }
      if (confirming) return
      confirming = true
      const version = status.version
      try {
        if (await confirmInstall()) {
          if (!closed && status.state === 'ready' && status.version === version) await run(install)
        }
      } finally {
        confirming = false
      }
    },
    close(): void {
      closed = true
      updater?.removeListener('update-available', available)
      updater?.removeListener('update-not-available', notAvailable)
      updater?.removeListener('download-progress', progress)
      updater?.removeListener('update-downloaded', downloaded)
      updater?.removeListener('error', failed)
    }
  }
}

export type DesktopUpdater = ReturnType<typeof createDesktopUpdater>
