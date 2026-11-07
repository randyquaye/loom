import { describe, expect, it } from 'vitest'
import { deriveBlocks } from '../src/shared/blocks'
import type { AgentEvent } from '../src/shared/events'

const T = 'turn-a'
const events: AgentEvent[] = [
  { type: 'user.text', turnId: 'u1', text: 'find writers' },
  { type: 'turn.started', turnId: T, at: 0 },
  { type: 'text.done', turnId: T, text: 'Looking.' },
  { type: 'reasoning.delta', turnId: T, text: 'hmm' },
  { type: 'tool.call', turnId: T, callId: 'c1', name: 'bash', args: { command: 'ls' } },
  { type: 'tool.result', turnId: T, callId: 'c1', ok: true, output: 'a' },
  { type: 'error', code: 'x', message: 'boom', retryable: false },
  { type: 'text.done', turnId: T, text: 'Done.' },
  { type: 'turn.done', turnId: T, stopReason: 'end' }
]

describe('deriveBlocks turnId', () => {
  it('tags every block with its producing turn, leaving turn-less errors untagged', () => {
    expect(deriveBlocks(events).map((b) => [b.kind, b.turnId])).toEqual([
      ['user', 'u1'],
      ['text', T],
      ['reasoning', T],
      ['tool', T],
      ['error', undefined],
      ['text', T]
    ])
  })
})
