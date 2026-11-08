import type { AgentEvent } from './events'
import type { TalkPhase } from './stt'

/** What the agent is busy with; the stage formats it (tools reuse the transcript's summary). */
export type VoiceActivity =
  { kind: 'tool'; name: string; args: unknown } | { kind: 'subagent'; description: string }

export type VoiceState =
  | { kind: 'ready' }
  | { kind: 'listening' }
  | { kind: 'finalizing' }
  | { kind: 'thinking' }
  | { kind: 'working'; activity: VoiceActivity }
  | { kind: 'speaking' }
  | { kind: 'error'; message: string }

/**
 * The voice stage's single state. Your own talking wins, then audible speech, then the
 * latest turn as told by the event stream. Only events after the last user message count,
 * so a sent message reads as thinking even before (or without) turn.started, and an error
 * holds until the next message unless the agent visibly carries on.
 */
export function deriveVoiceState(
  events: readonly AgentEvent[],
  talk: TalkPhase,
  speaking: boolean
): VoiceState {
  if (talk === 'capturing') return { kind: 'listening' }
  if (talk === 'finalizing') return { kind: 'finalizing' }
  if (speaking) return { kind: 'speaking' }

  const start = events.findLastIndex((event) => event.type === 'user.text')
  if (start === -1) return { kind: 'ready' }
  const open = new Map<string, VoiceActivity>()
  let error: string | null = null
  for (const event of events.slice(start + 1)) {
    switch (event.type) {
      case 'tool.call':
        open.set(event.callId, { kind: 'tool', name: event.name, args: event.args })
        error = null
        break
      case 'subagent.start':
        open.set(event.callId, { kind: 'subagent', description: event.description })
        error = null
        break
      case 'tool.result':
      case 'subagent.end':
        open.delete(event.callId)
        break
      case 'text.delta':
      case 'text.done':
      case 'reasoning.delta':
        error = null
        break
      case 'error':
        error = event.message
        break
      case 'turn.done':
        if (error !== null) return { kind: 'error', message: error }
        return event.stopReason === 'error'
          ? { kind: 'error', message: 'The turn failed' }
          : { kind: 'ready' }
    }
  }
  if (error !== null) return { kind: 'error', message: error }
  const activity = [...open.values()].at(-1)
  return activity === undefined ? { kind: 'thinking' } : { kind: 'working', activity }
}

/**
 * What the last finished reply contained that speech skips, so the stage can point at it.
 * null while a turn is still running (or none has run). Fences are counted from text.done,
 * which every backend emits with the complete text.
 */
export function unspokenCounts(
  events: readonly AgentEvent[]
): { codeBlocks: number; fileEdits: number } | null {
  const start = events.findLastIndex((event) => event.type === 'user.text')
  const boundary = events.findLast((event) => event.type === 'user.text' || event.type === 'turn.done')
  if (start === -1 || boundary?.type !== 'turn.done') return null
  let fences = 0
  let fileEdits = 0
  for (const event of events.slice(start + 1)) {
    if (event.type === 'text.done')
      fences += event.text.split('\n').filter((l) => l.trimStart().startsWith('```')).length
    else if (event.type === 'tool.call' && (event.name === 'write_file' || event.name === 'edit_file'))
      fileEdits += 1
  }
  return { codeBlocks: Math.floor(fences / 2), fileEdits }
}
