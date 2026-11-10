import { describe, expect, it } from 'vitest'
import { deriveBlocks } from '../src/shared/blocks'
import type { AgentEvent } from '../src/shared/events'
import { eventsToMarkdown } from '../src/main/export/markdown'

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
  it('keeps a renderable turn after a silent cancellation, including after guidance', () => {
    const quiet: AgentEvent[] = [
      { type: 'user.text', turnId: 'user', text: 'work' },
      { type: 'turn.started', turnId: T, at: 1 },
      { type: 'usage', turnId: T, inputTokens: 10, outputTokens: 2 },
      { type: 'turn.done', turnId: T, stopReason: 'cancelled', at: 2 }
    ]
    const last = deriveBlocks(quiet).at(-1)
    expect(last).toMatchObject({ kind: 'text', turnId: T })
    const guided = [
      ...quiet.slice(0, -1),
      { type: 'user.steer', turnId: T, text: 'guidance' } as const,
      quiet.at(-1)!
    ]
    expect(deriveBlocks(guided).at(-1)).toMatchObject({ kind: 'text', turnId: T })
  })
  it('keeps questions separate from surrounding text and resolves only the matching request', () => {
    const request: AgentEvent = {
      type: 'question.requested',
      requestId: 'q1',
      turnId: T,
      blocking: true,
      questions: [{ id: 'pick', header: 'Choice', question: 'Which?', isOther: true, isSecret: false }]
    }
    const blocks = deriveBlocks([
      { type: 'text.done', turnId: T, text: 'Before' },
      request,
      { ...request, requestId: 'q2' },
      { type: 'question.resolved', turnId: T, requestId: 'q1' },
      { type: 'text.done', turnId: T, text: 'After' }
    ])
    expect(blocks.map((block) => block.kind)).toEqual(['text', 'question', 'question', 'text'])
    expect(
      blocks.filter((block) => block.kind === 'question').map((block) => [block.id, block.resolved])
    ).toEqual([
      ['q1', true],
      ['q2', false]
    ])
    expect(blocks.filter((block) => block.kind === 'text').map((block) => block.text)).toEqual([
      'Before',
      'After'
    ])
    expect(
      eventsToMarkdown({ title: 'Questions', backend: 'codex', model: 'm', effort: 'high', createdAt: 0 }, [
        request
      ])
    ).toContain('Which?')
  })

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
