import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopUpdateStatus } from '../../shared/desktop-updates'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function fixture() {
  const initial = deferred<DesktopUpdateStatus>()
  let push!: (status: DesktopUpdateStatus) => void
  const updates = {
    status: vi.fn(() => initial.promise),
    check: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {})
  }
  vi.stubGlobal('window', {
    loom: {
      updates,
      onUpdateStatus: vi.fn((receive: typeof push) => {
        push = receive
        return () => {}
      })
    }
  })
  const { subscribeDesktopUpdates, useDesktopUpdates } = await import('./desktop-updates')
  subscribeDesktopUpdates()
  return { initial, push, updates, useDesktopUpdates, subscribeDesktopUpdates }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('keeps pushed download progress when the startup snapshot arrives late', async () => {
  const fx = await fixture()
  const progress: DesktopUpdateStatus = {
    currentVersion: '1.0.0',
    state: 'downloading',
    version: '1.1.0',
    percent: 45
  }
  fx.push(progress)
  fx.initial.resolve({ currentVersion: '1.0.0', state: 'idle' })
  await expect(fx.initial.promise).resolves.toMatchObject({ state: 'idle' })
  expect(fx.useDesktopUpdates.getState().status).toEqual(progress)
})

it('ignores a stale startup failure after a ready update was announced', async () => {
  const fx = await fixture()
  const ready: DesktopUpdateStatus = { currentVersion: '1.0.0', state: 'ready', version: '1.1.0' }
  fx.push(ready)
  fx.initial.reject(new Error('Old status request failed'))
  await expect(fx.initial.promise).rejects.toThrow('Old status request failed')
  expect(fx.useDesktopUpdates.getState()).toMatchObject({ status: ready, error: null })
})

it('releases failed controls for retry without discarding the available update', async () => {
  const fx = await fixture()
  const available: DesktopUpdateStatus = { currentVersion: '1.0.0', state: 'available', version: '1.1.0' }
  fx.push(available)
  fx.initial.resolve(available)
  fx.updates.download.mockRejectedValueOnce(new Error('Download interrupted'))
  await fx.useDesktopUpdates.getState().run('download')
  expect(fx.useDesktopUpdates.getState()).toMatchObject({
    status: available,
    error: 'Download interrupted',
    pending: null
  })
  await fx.useDesktopUpdates.getState().run('download')
  expect(fx.updates.download).toHaveBeenCalledTimes(2)
  expect(fx.useDesktopUpdates.getState()).toMatchObject({ error: null, pending: null })
})

it('does not hide a newer ready update when an earlier check rejects', async () => {
  const fx = await fixture()
  fx.initial.resolve({ currentVersion: '1.0.0', state: 'idle' })
  const check = deferred<void>()
  fx.updates.check.mockReturnValueOnce(check.promise)
  const running = fx.useDesktopUpdates.getState().run('check')
  const ready: DesktopUpdateStatus = { currentVersion: '1.0.0', state: 'ready', version: '1.1.0' }
  fx.push(ready)
  check.reject(new Error('Earlier check failed'))
  await running
  expect(fx.useDesktopUpdates.getState()).toMatchObject({ status: ready, error: null, pending: null })
  expect(fx.updates.download).not.toHaveBeenCalled()
  expect(fx.updates.install).not.toHaveBeenCalled()
})

it('subscribes once and never downloads or installs while loading or checking', async () => {
  const fx = await fixture()
  fx.subscribeDesktopUpdates()
  fx.initial.resolve({ currentVersion: '1.0.0', state: 'idle' })
  await fx.useDesktopUpdates.getState().run('check')
  expect(window.loom.onUpdateStatus).toHaveBeenCalledTimes(1)
  expect(fx.updates.status).toHaveBeenCalledTimes(1)
  expect(fx.updates.check).toHaveBeenCalledTimes(1)
  expect(fx.updates.download).not.toHaveBeenCalled()
  expect(fx.updates.install).not.toHaveBeenCalled()
})

it('keeps background errors quiet until a person uses the update controls', async () => {
  const fx = await fixture()
  fx.initial.resolve({ currentVersion: '1.0.0', state: 'idle' })
  const offline: DesktopUpdateStatus = { currentVersion: '1.0.0', state: 'error', message: 'Offline' }
  fx.push(offline)
  expect(fx.useDesktopUpdates.getState()).toMatchObject({ status: offline, interacted: false })
  await fx.useDesktopUpdates.getState().run('check')
  fx.push(offline)
  expect(fx.useDesktopUpdates.getState()).toMatchObject({ status: offline, interacted: true })
  expect(fx.updates.download).not.toHaveBeenCalled()
  expect(fx.updates.install).not.toHaveBeenCalled()
})
