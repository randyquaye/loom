import { create } from 'zustand'

const KEY = 'loom.preferences'

interface Preferences {
  completionSoundEnabled: boolean
  steerByDefault: boolean
}

function loadPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as {
      completionSoundEnabled?: unknown
      steerByDefault?: unknown
    } | null
    return {
      completionSoundEnabled: saved?.completionSoundEnabled !== false,
      steerByDefault: saved?.steerByDefault === true
    }
  } catch {
    return { completionSoundEnabled: true, steerByDefault: false }
  }
}

export const usePreferences = create<
  Preferences & {
    setCompletionSoundEnabled(enabled: boolean): void
    setSteerByDefault(enabled: boolean): void
  }
>((set, get) => {
  function update(patch: Partial<Preferences>) {
    const { completionSoundEnabled, steerByDefault } = get()
    const preferences = { completionSoundEnabled, steerByDefault, ...patch }
    localStorage.setItem(KEY, JSON.stringify(preferences))
    set(preferences)
  }
  return {
    ...loadPreferences(),
    setCompletionSoundEnabled: (completionSoundEnabled) => update({ completionSoundEnabled }),
    setSteerByDefault: (steerByDefault) => update({ steerByDefault })
  }
})
