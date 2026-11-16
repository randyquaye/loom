import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { AutoUpdater } from 'electron'
import { createMacInstaller } from '../src/main/updates/install'

function fixture() {
  const native = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn()
  })
  const installer = createMacInstaller(native as unknown as AutoUpdater)
  const listenersGone = () => {
    expect(native.listenerCount('update-downloaded')).toBe(0)
    expect(native.listenerCount('error')).toBe(0)
  }
  return { native, installer, listenersGone }
}

afterEach(() => vi.useRealTimers())

it('quits only after native verification and removes completed listeners', async () => {
  const { native, installer, listenersGone } = fixture()
  const pending = installer.install()
  expect(native.checkForUpdates).toHaveBeenCalledTimes(1)
  expect(native.quitAndInstall).not.toHaveBeenCalled()
  native.emit('update-downloaded')
  await pending
  expect(native.quitAndInstall).toHaveBeenCalledTimes(1)
  listenersGone()
  installer.close()
})

it('rejects signature failures and prevents late native completion from restarting', async () => {
  const { native, installer, listenersGone } = fixture()
  const pending = installer.install()
  native.emit('error', new Error('Code signature validation failed'))
  await expect(pending).rejects.toThrow('Code signature validation failed')
  listenersGone()
  native.emit('update-downloaded')
  expect(native.quitAndInstall).not.toHaveBeenCalled()
  installer.close()
})

it('cancels native preparation on close and refuses later installation', async () => {
  const { native, installer, listenersGone } = fixture()
  const pending = installer.install()
  installer.close()
  await expect(pending).rejects.toThrow(/closed|cancel/i)
  listenersGone()
  native.emit('update-downloaded')
  expect(native.quitAndInstall).not.toHaveBeenCalled()
  await expect(installer.install()).rejects.toThrow(/closed|cancel/i)
})

it('bounds stalled native preparation and ignores completion after its timeout', async () => {
  vi.useFakeTimers()
  const { native, installer, listenersGone } = fixture()
  const pending = installer.install()
  const refused = expect(pending).rejects.toThrow(/timed out/i)
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
  await refused
  listenersGone()
  expect(vi.getTimerCount()).toBe(0)
  native.emit('update-downloaded')
  expect(native.quitAndInstall).not.toHaveBeenCalled()
  installer.close()
})

it('shares native preparation across duplicate requests and restarts once', async () => {
  const { native, installer, listenersGone } = fixture()
  const first = installer.install()
  const second = installer.install()
  expect(native.checkForUpdates).toHaveBeenCalledTimes(1)
  native.emit('update-downloaded')
  await Promise.all([first, second])
  expect(native.quitAndInstall).toHaveBeenCalledTimes(1)
  listenersGone()
  installer.close()
})

it('cleans up when native preparation throws and allows an explicit retry', async () => {
  const { native, installer, listenersGone } = fixture()
  native.checkForUpdates.mockImplementationOnce(() => {
    throw new Error('Native updater unavailable')
  })
  await expect(installer.install()).rejects.toThrow('Native updater unavailable')
  listenersGone()
  const retry = installer.install()
  native.emit('update-downloaded')
  await retry
  expect(native.quitAndInstall).toHaveBeenCalledTimes(1)
  installer.close()
})

it('reports a native quit failure after removing the preparation listeners', async () => {
  const { native, installer, listenersGone } = fixture()
  native.quitAndInstall.mockImplementationOnce(() => {
    throw new Error('Cannot restart')
  })
  const pending = installer.install()
  native.emit('update-downloaded')
  await expect(pending).rejects.toThrow('Cannot restart')
  listenersGone()
  installer.close()
})
