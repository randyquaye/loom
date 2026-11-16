import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  app: { isPackaged: true, getAppPath: () => '/fixture/Loom.app', getVersion: () => '1.0.0' },
  readFile: vi.fn(),
  warn: vi.fn()
}))
vi.mock('electron', () => ({ app: fixture.app, autoUpdater: {}, dialog: {} }))
vi.mock('node:fs/promises', () => ({ readFile: fixture.readFile }))
import { openDesktopUpdater } from '../src/main/updates'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  fixture.app.isPackaged = true
  fixture.readFile.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(fixture.warn)
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
})

it.each([
  ['unreadable release metadata', () => fixture.readFile.mockRejectedValue(new Error('Read failed'))],
  ['invalid update metadata', () => fixture.readFile.mockResolvedValue('{broken')],
  [
    'an invalid feed URL',
    () =>
      fixture.readFile.mockResolvedValue(
        JSON.stringify({
          loomDesktopUpdates: { url: 'http://insecure.example.test/', teamId: 'ABCDE12345' }
        })
      )
  ]
])('keeps Loom available despite %s', async (_name, prepare) => {
  prepare()
  const updates = await openDesktopUpdater(vi.fn())
  expect(updates.status()).toEqual({ state: 'unavailable', currentVersion: '1.0.0' })
  await expect(updates.check()).rejects.toThrow(/unavailable/i)
  updates.close()
})

it('never loads feed metadata in a development build', async () => {
  fixture.app.isPackaged = false
  const updates = await openDesktopUpdater(vi.fn())
  expect(fixture.readFile).not.toHaveBeenCalled()
  expect(updates.status().state).toBe('unavailable')
  updates.close()
})
