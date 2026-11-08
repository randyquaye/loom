import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/shared/events'
import { deriveVoiceState } from '../src/shared/voice'

const t = 't1'
const user: AgentEvent = { type: 'user.text', turnId: t, text: 'fix it' }
const started: AgentEvent = { type: 'turn.started', turnId: t, at: 1 }
const call = (callId: string, name = 'Read'): AgentEvent => ({
  type: 'tool.call',
  turnId: t,
  callId,
  name,
  args: { file_path: `src/${callId}.ts` }
})
const result = (callId: string): AgentEvent => ({
  type: 'tool.result',
  turnId: t,
  callId,
  ok: true,
  output: ''
})
const done = (stopReason: 'end' | 'error' = 'end'): AgentEvent => ({
  type: 'turn.done',
  turnId: t,
  stopReason
})

/** The stage reads only the event stream, so each backend's ordering must land on the right state. */
const stateOf = (events: AgentEvent[]) => deriveVoiceState(events, 'idle', false)

describe('voice stage state across backend event orderings', () => {
  it('waits in thinking from send until the backend reports anything', () => {
    expect(stateOf([])).toEqual({ kind: 'ready' })
    expect(stateOf([user])).toEqual({ kind: 'thinking' })
    expect(stateOf([user, started])).toEqual({ kind: 'thinking' })
  })

  it('streams text, then works on a tool, then returns to thinking (claude, loop backends)', () => {
    const streamed: AgentEvent[] = [user, started, { type: 'text.delta', turnId: t, text: 'Looking. ' }]
    expect(stateOf(streamed)).toEqual({ kind: 'thinking' })
    const working = [...streamed, call('a')]
    expect(stateOf(working)).toEqual({
      kind: 'working',
      activity: { kind: 'tool', name: 'Read', args: { file_path: 'src/a.ts' } }
    })
    expect(stateOf([...working, result('a')])).toEqual({ kind: 'thinking' })
    expect(stateOf([...working, result('a'), done()])).toEqual({ kind: 'ready' })
  })

  it('stays working while any parallel call is still open, showing the latest open one', () => {
    const events = [user, started, call('a'), call('b', 'Grep'), result('b')]
    expect(stateOf(events)).toMatchObject({ kind: 'working', activity: { kind: 'tool', name: 'Read' } })
  })

  it('handles codex emitting only text.done at the end of a turn', () => {
    const mid = [user, started, call('a', 'Bash'), result('a')]
    expect(stateOf(mid)).toEqual({ kind: 'thinking' })
    expect(stateOf([...mid, { type: 'text.done', turnId: t, text: 'Done.' }, done()])).toEqual({
      kind: 'ready'
    })
  })

  it('treats a subagent as work until it ends', () => {
    const events: AgentEvent[] = [
      user,
      started,
      { type: 'subagent.start', turnId: t, callId: 's', description: 'Survey the parser' }
    ]
    expect(stateOf(events)).toEqual({
      kind: 'working',
      activity: { kind: 'subagent', description: 'Survey the parser' }
    })
    expect(stateOf([...events, { type: 'subagent.end', turnId: t, callId: 's', ok: true }])).toEqual({
      kind: 'thinking'
    })
  })

  it('surfaces a failed turn until the next message, including turn-less spawn failures', () => {
    const failed: AgentEvent[] = [
      user,
      started,
      { type: 'error', turnId: t, code: 'backend', message: 'rate limited', retryable: false },
      done('error')
    ]
    expect(stateOf(failed)).toEqual({ kind: 'error', message: 'rate limited' })
    expect(stateOf([...failed, { ...user, turnId: 't2' }])).toEqual({ kind: 'thinking' })
    const spawn: AgentEvent[] = [
      user,
      { type: 'error', code: 'spawn', message: 'spawn codex ENOENT', retryable: false }
    ]
    expect(stateOf(spawn)).toEqual({ kind: 'error', message: 'spawn codex ENOENT' })
  })

  it('drops a recoverable mid-turn error once the agent carries on', () => {
    const events: AgentEvent[] = [
      user,
      started,
      { type: 'error', code: 'checkpoint.save', message: 'checkpoint failed', retryable: false },
      { type: 'text.delta', turnId: t, text: 'Continuing. ' },
      done()
    ]
    expect(stateOf(events)).toEqual({ kind: 'ready' })
  })
})
