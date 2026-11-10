import { describe, expect, it } from 'vitest'
import { parseCodexNotification } from '../src/main/agents/cli/codex-notifications'
import { deriveBlocks } from '../src/shared/blocks'
import type { RpcCall } from '../src/main/agents/cli/rpc'

const THREAD = 'thread'
const TURN = 'turn'
const START = 1_794_225_900
const END = START + 42
const parse = (method: string, params: Record<string, unknown>) =>
  parseCodexNotification({ method, params: { threadId: THREAD, ...params } }, THREAD)

describe('Codex app-server turn notifications', () => {
  it('preserves the provider turn identity and second-based timestamps for history', () => {
    expect(parse('turn/started', { turn: { id: TURN, startedAt: START } })).toEqual([
      { type: 'turn.started', turnId: TURN, at: START * 1000 }
    ])
    expect(parse('turn/completed', { turn: { id: TURN, status: 'completed', completedAt: END } })).toEqual([
      { type: 'turn.done', turnId: TURN, stopReason: 'end', at: END * 1000 }
    ])
  })

  it('reconciles streamed text with the authoritative final message without duplication', () => {
    const events = [
      ...parse('item/agentMessage/delta', { turnId: TURN, itemId: 'message', delta: 'Hel' }),
      ...parse('item/agentMessage/delta', { turnId: TURN, itemId: 'message', delta: 'lo' }),
      ...parse('item/completed', {
        turnId: TURN,
        item: { type: 'agentMessage', id: 'message', text: 'Hello!' }
      })
    ]
    expect(events.map((event) => event.type)).toEqual(['text.delta', 'text.delta', 'text.done'])
    const blocks = deriveBlocks(events)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'text', turnId: TURN, text: 'Hello!' })
  })

  it.each([
    ['completed', 'end'],
    ['interrupted', 'cancelled'],
    ['failed', 'error']
  ])('distinguishes %s from other terminal outcomes', (status, stopReason) => {
    const events = parse('turn/completed', {
      turn: { id: TURN, status, completedAt: END, error: { message: 'provider detail' } }
    })
    expect(events.at(-1)).toEqual({ type: 'turn.done', turnId: TURN, stopReason, at: END * 1000 })
    expect(events.filter((event) => event.type === 'error')).toHaveLength(status === 'failed' ? 1 : 0)
    if (status === 'failed') expect(events[0]).toMatchObject({ message: 'provider detail', retryable: false })
  })

  it('reports retryable failures without ending an active turn', () => {
    expect(
      parse('error', {
        turnId: TURN,
        error: { message: 'Retrying connection', codexErrorInfo: 'streamConnectionFailed' },
        willRetry: true
      })
    ).toEqual([
      {
        type: 'error',
        turnId: TURN,
        code: 'streamConnectionFailed',
        message: 'Retrying connection',
        retryable: true
      }
    ])
  })

  it('ignores unrelated threads and unsupported notifications', () => {
    const message: RpcCall = {
      method: 'turn/completed',
      params: { threadId: 'another-thread', turn: { id: TURN, status: 'completed' } }
    }
    expect(parseCodexNotification(message, THREAD)).toEqual([])
    expect(parse('thread/started', { thread: { id: THREAD } })).toEqual([])
  })
})
