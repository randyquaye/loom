import type { AutoUpdater } from 'electron'

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

/** Prepares Squirrel's configured local feed only after consent, then restarts once. */
export function createMacInstaller(
  native: Pick<AutoUpdater, 'once' | 'removeListener' | 'checkForUpdates' | 'quitAndInstall'>
) {
  let closed = false
  let pending: Promise<void> | null = null
  let cancel: ((error: Error) => void) | null = null

  return {
    install(): Promise<void> {
      if (closed) return Promise.reject(new Error('Update installer is closed'))
      if (pending !== null) return pending
      let resolve!: () => void
      let reject!: (error: Error) => void
      const promise = new Promise<void>((yes, no) => {
        resolve = yes
        reject = no
      })
      pending = promise

      function finish(error?: Error): void {
        if (pending !== promise) return
        clearTimeout(timer)
        native.removeListener('update-downloaded', downloaded)
        native.removeListener('error', failed)
        pending = null
        cancel = null
        if (error !== undefined) return reject(error)
        try {
          native.quitAndInstall()
          resolve()
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
      function downloaded(): void {
        finish()
      }
      function failed(error: Error): void {
        finish(error)
      }
      const timer = setTimeout(
        () => finish(new Error('Preparing the update timed out. Try again.')),
        INSTALL_TIMEOUT_MS
      )
      timer.unref()
      cancel = failed
      native.once('update-downloaded', downloaded)
      native.once('error', failed)
      try {
        native.checkForUpdates()
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
      return promise
    },
    close(): void {
      closed = true
      cancel?.(new Error('Update installation was cancelled because Loom closed'))
    }
  }
}
