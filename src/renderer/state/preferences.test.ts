import { expect, it, vi } from 'vitest'
import type { SessionEventPush } from '../../shared/ipc-contract'

it('alerts only when away, consumes silent completions, and remembers disabling sound', async () => {
  const saved = new Map<string, string>()
  let focused = true
  let receive!: (push: SessionEventPush) => void
  const play = vi.fn(async () => {})
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value)
  })
  vi.stubGlobal('document', { hasFocus: () => focused, visibilityState: 'visible' })
  vi.stubGlobal(
    'Audio',
    class {
      currentTime = 0
      play = play
    }
  )
  vi.stubGlobal('window', {
    loom: {
      onSessionEvent: (listener: typeof receive) => {
        receive = listener
      },
      onSessionTitle: vi.fn(),
      onWorkspaceState: vi.fn(),
      onSessionActivity: vi.fn(),
      sessions: { activity: async () => ({ revision: 0, bySession: {} }) }
    }
  })
  try {
    const { usePreferences } = await import('./preferences')
    const { subscribeSessionEvents, useSessions } = await import('./sessions')
    const { useUi } = await import('./ui')
    const { shouldPlayCompletionSound } = await import('../audio/completionPolicy')
    subscribeSessionEvents(shouldPlayCompletionSound)
    useUi.setState({ route: { name: 'workspace', workspaceId: 'w' }, workspacePane: 'chat' })
    useSessions.setState({ activeSessionByWorkspace: { w: 'foreground' } })
    const complete = (sessionId: string, turnId: string) => {
      receive({ sessionId, event: { type: 'turn.started', turnId, at: 1 } })
      receive({ sessionId, event: { type: 'turn.done', turnId, stopReason: 'end' } })
    }
    expect(usePreferences.getState().completionSoundEnabled).toBe(true)
    complete('foreground', 'seen')
    expect(play).not.toHaveBeenCalled()
    focused = false
    receive({ sessionId: 'foreground', event: { type: 'turn.done', turnId: 'seen', stopReason: 'end' } })
    expect(play).not.toHaveBeenCalled()
    complete('foreground', 'other-window')
    expect(play).toHaveBeenCalledTimes(1)
    focused = true
    complete('background', 'other-session')
    expect(play).toHaveBeenCalledTimes(2)
    useUi.setState({ workspacePane: 'viewer' })
    complete('foreground', 'viewing-file')
    expect(play).toHaveBeenCalledTimes(3)
    usePreferences.getState().setCompletionSoundEnabled(false)
    focused = false
    complete('background', 'disabled')
    expect(play).toHaveBeenCalledTimes(3)
    vi.resetModules()
    const { usePreferences: reloaded } = await import('./preferences')
    expect(reloaded.getState().completionSoundEnabled).toBe(false)
  } finally {
    vi.unstubAllGlobals()
    vi.resetModules()
  }
})
