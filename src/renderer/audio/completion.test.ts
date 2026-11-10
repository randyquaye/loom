import { expect, it, vi } from 'vitest'
import type { SessionEventPush } from '../../shared/ipc-contract'
import { createCompletionChime } from './completion'

const done = (sessionId: string, turnId: string): SessionEventPush => ({
  sessionId,
  event: { type: 'turn.done', turnId, stopReason: 'end' }
})

it('chimes once per session even when only the completion arrives after reload', () => {
  const play = vi.fn()
  const receive = createCompletionChime(play)
  receive(done('background', 'same-provider-id'))
  receive(done('background', 'same-provider-id'))
  receive(done('other', 'same-provider-id'))
  expect(play).toHaveBeenCalledTimes(2)
})

it.each(['cancelled', 'error', 'limit'] as const)('keeps %s completions silent', (stopReason) => {
  const play = vi.fn()
  const receive = createCompletionChime(play)
  receive({ sessionId: 's', event: { type: 'turn.done', turnId: 't', stopReason } })
  expect(play).not.toHaveBeenCalled()
})

it('ignores retired completions during and after a newer turn', () => {
  const play = vi.fn()
  const receive = createCompletionChime(play)
  receive({ sessionId: 's', event: { type: 'user.text', turnId: 'prompt', text: 'work' } })
  receive({ sessionId: 's', event: { type: 'turn.started', turnId: 'current', at: 1 } })
  receive(done('s', 'retired'))
  expect(play).not.toHaveBeenCalled()
  receive(done('s', 'current'))
  receive(done('s', 'retired'))
  receive(done('s', 'current'))
  expect(play).toHaveBeenCalledTimes(1)
})
