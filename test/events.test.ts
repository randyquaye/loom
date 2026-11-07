import { describe, expect, it } from 'vitest'
import { agentEvent, renderEventForSearch, type AgentEvent } from '../src/shared/events'

const samples: AgentEvent[] = [
  { type: 'turn.started', turnId: 't', at: 1 },
  { type: 'text.delta', turnId: 't', text: 'hi' },
  { type: 'text.done', turnId: 't', text: 'hi' },
  { type: 'reasoning.delta', turnId: 't', text: 'thinking' },
  { type: 'tool.call', turnId: 't', callId: 'c', name: 'bash', args: { cmd: 'ls' } },
  { type: 'tool.result', turnId: 't', callId: 'c', ok: true, output: 'ok' },
  { type: 'usage', turnId: 't', inputTokens: 1, outputTokens: 2 },
  { type: 'error', code: 'E', message: 'boom', retryable: false },
  { type: 'turn.done', turnId: 't', stopReason: 'end' }
]

describe('AgentEvent schema', () => {
  it('accepts every event variant', () => {
    for (const event of samples) {
      expect(agentEvent.parse(event)).toEqual(event)
    }
  })

  it('rejects unknown event types', () => {
    expect(() => agentEvent.parse({ type: 'nope', turnId: 't' })).toThrow()
  })

  it('rejects a bad stopReason', () => {
    expect(() => agentEvent.parse({ type: 'turn.done', turnId: 't', stopReason: 'maybe' })).toThrow()
  })
})

describe('renderEventForSearch', () => {
  it('indexes message and tool text, ignores lifecycle events', () => {
    expect(renderEventForSearch({ type: 'text.done', turnId: 't', text: 'hello' })).toBe('hello')
    expect(
      renderEventForSearch({ type: 'tool.result', turnId: 't', callId: 'c', ok: true, output: 'out' })
    ).toBe('out')
    expect(renderEventForSearch({ type: 'usage', turnId: 't', inputTokens: 1, outputTokens: 1 })).toBe('')
  })
})
