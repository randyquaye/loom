import { create } from 'zustand'

const KEY = 'loom.preferences'

function loadSoundEnabled(): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as {
      completionSoundEnabled?: unknown
    } | null
    return saved?.completionSoundEnabled !== false
  } catch {
    return true
  }
}

export const usePreferences = create<{
  completionSoundEnabled: boolean
  setCompletionSoundEnabled(enabled: boolean): void
}>((set) => ({
  completionSoundEnabled: loadSoundEnabled(),
  setCompletionSoundEnabled: (completionSoundEnabled) => {
    localStorage.setItem(KEY, JSON.stringify({ completionSoundEnabled }))
    set({ completionSoundEnabled })
  }
}))
