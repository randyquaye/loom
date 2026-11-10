import { describe, expect, it } from 'vitest'
import { usageByTurn } from '../src/shared/usage'
import type { AgentEvent } from '../src/shared/events'

describe('turn usage', () => {
  it('replaces snapshots, sums explicit request measurements, and retains cancelled-turn cache counts', () => {
    const events: AgentEvent[] = [
      {
        type: 'usage',
        turnId: 'turn',
        inputTokens: 10,
        outputTokens: 2,
        scope: 'turn',
        cacheReadInputTokens: 0
      },
      {
        type: 'usage',
        turnId: 'turn',
        inputTokens: 20,
        outputTokens: 4,
        scope: 'turn',
        cacheReadInputTokens: 6
      },
      {
        type: 'usage',
        turnId: 'turn',
        inputTokens: 20,
        outputTokens: 4,
        scope: 'turn',
        cacheReadInputTokens: 6
      },
      { type: 'turn.done', turnId: 'turn', stopReason: 'cancelled' },
      { type: 'usage', turnId: 'other', inputTokens: 3, outputTokens: 1, scope: 'request' },
      {
        type: 'usage',
        turnId: 'other',
        inputTokens: 4,
        outputTokens: 2,
        scope: 'request',
        cacheWriteInputTokens: 0
      }
    ]
    expect(usageByTurn(events).get('turn')).toMatchObject({
      inputTokens: 20,
      outputTokens: 4,
      cacheReadInputTokens: 6
    })
    expect(usageByTurn(events).get('other')).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      cacheWriteInputTokens: 0
    })
    expect(usageByTurn(events).get('turn')?.cacheWriteInputTokens).toBeUndefined()
  })
})
