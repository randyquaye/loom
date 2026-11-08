import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('preserves voice and model preferences independently across reloads', async () => {
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value)
  })
  const { useDefaults } = await import('../src/renderer/state/defaults')
  useDefaults.getState().setVoiceId('first-voice')
  const model = { backend: 'claude', model: 'preferred-model', effort: 'medium' } as const
  useDefaults.getState().add(model)

  vi.resetModules()
  const { useDefaults: reloaded } = await import('../src/renderer/state/defaults')
  expect(reloaded.getState().voiceId).toBe('first-voice')
  expect(reloaded.getState().loadout).toEqual([model])
  reloaded.getState().setVoiceId('second-voice')

  vi.resetModules()
  const { useDefaults: final } = await import('../src/renderer/state/defaults')
  expect(final.getState().voiceId).toBe('second-voice')
  expect(final.getState().loadout).toEqual([model])
})
