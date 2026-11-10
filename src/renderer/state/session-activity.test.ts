import { expect, it, vi } from 'vitest'
import { subscribeSessionEvents, useSessions } from './sessions'

it('keeps pushed activity when an older startup snapshot arrives afterward', async () => {
  type Activity = { revision: number; bySession: Record<string, string> }
  let push!: (activity: Activity) => void
  let resolve!: (activity: Activity) => void
  vi.stubGlobal('window', {
    loom: {
      onSessionEvent: vi.fn(),
      onSessionTitle: vi.fn(),
      onSessionActivity: (listener: typeof push) => {
        push = listener
      },
      sessions: {
        activity: () =>
          new Promise<Activity>((done) => {
            resolve = done
          })
      }
    }
  })
  try {
    subscribeSessionEvents()
    push({ revision: 2, bySession: { s: 'background-workspace' } })
    resolve({ revision: 1, bySession: {} })
    await Promise.resolve()
    expect(useSessions.getState().activity.bySession).toEqual({ s: 'background-workspace' })
  } finally {
    vi.unstubAllGlobals()
  }
})
