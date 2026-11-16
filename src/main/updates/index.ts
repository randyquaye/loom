import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { app, autoUpdater, dialog } from 'electron'
import { createDesktopUpdater, type NativeUpdater } from './service'
import { createMacInstaller } from './install'
import type { DesktopUpdateStatus } from '../../shared/desktop-updates'

/** Only signed release builds contain both the feed configuration and publisher identity. */
export async function openDesktopUpdater(changed: (status: DesktopUpdateStatus) => void) {
  let updater: NativeUpdater | null = null
  let installer: ReturnType<typeof createMacInstaller> | null = null
  try {
    if (app.isPackaged && process.platform === 'darwin') {
      const metadata = JSON.parse(await readFile(path.join(app.getAppPath(), 'package.json'), 'utf8')) as {
        loomDesktopUpdates?: { url?: unknown; teamId?: unknown }
      }
      const config = metadata.loomDesktopUpdates
      if (typeof config?.url === 'string' && typeof config.teamId === 'string') {
        const url = new URL(config.url)
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          !/^[A-Z0-9]{10}$/.test(config.teamId)
        )
          throw new Error('Invalid desktop update configuration')
        const { default: electronUpdater } = await import('electron-updater')
        updater = electronUpdater.autoUpdater
        installer = createMacInstaller(autoUpdater)
      }
    }
  } catch (error) {
    // Updating is optional; a broken update setup must not prevent ordinary app use.
    console.warn('[loom] Automatic updates are unavailable:', error)
    updater = null
  }
  const updates = createDesktopUpdater({
    updater,
    currentVersion: app.getVersion(),
    changed,
    async install() {
      if (installer === null) throw new Error('Automatic updates are unavailable in this build')
      await installer.install()
    },
    async confirmInstall() {
      const result = await dialog.showMessageBox({
        type: 'question',
        title: 'Restart Loom to install the update?',
        message: 'Loom will close and reopen with the new version.',
        detail: 'Local agent sessions and terminals will close. Work on your cloud runner will keep running.',
        buttons: ['Restart and install', 'Later'],
        defaultId: 1,
        cancelId: 1
      })
      return result.response === 0
    }
  })
  return {
    ...updates,
    close() {
      updates.close()
      installer?.close()
    }
  }
}
