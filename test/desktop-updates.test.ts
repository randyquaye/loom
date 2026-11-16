import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createDesktopUpdater, type NativeUpdater } from '../src/main/updates/service'

class UpdateSource extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  allowDowngrade = true
  allowPrerelease = true
  checkForUpdates = vi.fn(async () => null)
  downloadUpdate = vi.fn(async () => [])
  quitAndInstall = vi.fn()
}

function setup(enabled = true) {
  const source = new UpdateSource()
  const changed = vi.fn()
  const confirmInstall = vi.fn(async () => true)
  const updates = createDesktopUpdater({
    updater: enabled ? (source as unknown as NativeUpdater) : null,
    currentVersion: '1.0.0',
    changed,
    confirmInstall,
    install: async () => {
      source.quitAndInstall()
    }
  })
  return { source, changed, confirmInstall, updates }
}

describe('desktop update consent and failure handling', () => {
  it('announces an available update without downloading or installing it', async () => {
    const { source, updates } = setup()
    await updates.check()
    source.emit('update-available', { version: '1.1.0' })
    expect(updates.status()).toEqual({ state: 'available', currentVersion: '1.0.0', version: '1.1.0' })
    expect(source.autoDownload).toBe(false)
    expect(source.autoInstallOnAppQuit).toBe(false)
    expect(source.downloadUpdate).not.toHaveBeenCalled()
    expect(source.quitAndInstall).not.toHaveBeenCalled()
    updates.close()
  })

  it('downloads on request, tracks progress, and installs only after restart consent', async () => {
    const { source, updates, confirmInstall } = setup()
    await updates.check()
    source.emit('update-available', { version: '1.1.0' })
    await expect(updates.install()).rejects.toThrow()
    await updates.download()
    source.emit('download-progress', { percent: 45.2 })
    expect(updates.status()).toEqual({
      state: 'downloading',
      currentVersion: '1.0.0',
      version: '1.1.0',
      percent: 45.2
    })
    source.emit('update-downloaded', { version: '1.1.0' })
    expect(source.quitAndInstall).not.toHaveBeenCalled()
    confirmInstall.mockResolvedValueOnce(false)
    await updates.install()
    expect(source.quitAndInstall).not.toHaveBeenCalled()
    await updates.install()
    expect(source.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(source.quitAndInstall).toHaveBeenCalledTimes(1)
    updates.close()
  })

  it('cannot install an update whose verification failed or whose completion arrived late', async () => {
    const { source, updates } = setup()
    await updates.check()
    source.emit('update-available', { version: '1.1.0' })
    await updates.download()
    source.emit('error', new Error('Code signature validation failed'))
    source.emit('update-downloaded', { version: '1.1.0' })
    expect(updates.status()).toMatchObject({ state: 'error' })
    await expect(updates.install()).rejects.toThrow()
    expect(source.quitAndInstall).not.toHaveBeenCalled()
    await updates.check()
    source.emit('update-not-available', { version: '1.0.0' })
    expect(updates.status()).toEqual({ state: 'idle', currentVersion: '1.0.0' })
    updates.close()
  })

  it('invalidates restart consent when the ready update fails while confirmation is open', async () => {
    const { source, updates, confirmInstall } = setup()
    await updates.check()
    source.emit('update-available', { version: '1.1.0' })
    await updates.download()
    source.emit('update-downloaded', { version: '1.1.0' })
    let answer!: (yes: boolean) => void
    confirmInstall.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const first = updates.install()
    const duplicate = updates.install()
    source.emit('error', new Error('Update became unavailable'))
    answer(true)
    await Promise.all([first, duplicate])
    expect(confirmInstall).toHaveBeenCalledTimes(1)
    expect(source.quitAndInstall).not.toHaveBeenCalled()
    updates.close()
  })

  it('reports a failed download and permits a fresh check without quitting the app', async () => {
    const { source, updates, changed } = setup()
    await updates.check()
    source.emit('update-available', { version: '1.1.0' })
    source.downloadUpdate.mockRejectedValueOnce(new Error('Network disconnected'))
    await expect(updates.download()).rejects.toThrow('Network disconnected')
    expect(changed).toHaveBeenLastCalledWith({
      state: 'error',
      currentVersion: '1.0.0',
      message: 'Network disconnected'
    })
    expect(source.quitAndInstall).not.toHaveBeenCalled()
    await updates.check()
    expect(source.checkForUpdates).toHaveBeenCalledTimes(2)
    updates.close()
  })

  it('leaves unsigned/development builds usable with automatic updating unavailable', async () => {
    const { updates, source, confirmInstall } = setup(false)
    expect(updates.status()).toEqual({ state: 'unavailable', currentVersion: '1.0.0' })
    await expect(updates.check()).rejects.toThrow(/unavailable/i)
    await expect(updates.download()).rejects.toThrow()
    await expect(updates.install()).rejects.toThrow()
    expect(source.checkForUpdates).not.toHaveBeenCalled()
    expect(confirmInstall).not.toHaveBeenCalled()
    updates.close()
  })

  it('does not replace a downloaded update with another check or redownload', async () => {
    const { source, updates } = setup()
    await updates.check()
    source.emit('update-available', { version: '1.1.0' })
    await updates.download()
    source.emit('update-downloaded', { version: '1.1.0' })
    await updates.check()
    await expect(updates.download()).rejects.toThrow()
    expect(updates.status()).toMatchObject({ state: 'ready', version: '1.1.0' })
    expect(source.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(source.downloadUpdate).toHaveBeenCalledTimes(1)
    updates.close()
  })
})
