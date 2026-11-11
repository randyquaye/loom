import type { AgentEvent } from '../../../shared/events'
import { codexItemEvents } from './codex-items'
import { errorEvent, isRec, num, str, sub, type Rec } from './record'
import type { RpcCall } from './rpc'

function timestamp(turn: Rec, key: string): number {
  const seconds = num(turn, key)
  return seconds === undefined ? Date.now() : seconds * 1000
}

function failure(turnId: string, detail: Rec | undefined, retryable: boolean): AgentEvent {
  const error = detail ?? {}
  return errorEvent(
    turnId,
    str(error, 'codexErrorInfo') ?? 'codex.error',
    str(error, 'message') ?? 'Codex reported an error',
    retryable
  )
}

/** Converts this thread's live turn/message notifications into Loom's persisted event format. */
export function parseCodexNotification(call: RpcCall, threadId: string): AgentEvent[] {
  const params = call.params
  if (!isRec(params) || str(params, 'threadId') !== threadId) return []
  const turn = sub(params, 'turn')
  const turnId = (turn === undefined ? undefined : str(turn, 'id')) ?? str(params, 'turnId')
  if (turnId === undefined) return []

  switch (call.method) {
    case 'turn/started':
      return turn === undefined ? [] : [{ type: 'turn.started', turnId, at: timestamp(turn, 'startedAt') }]
    case 'turn/completed': {
      if (turn === undefined) return []
      const status = str(turn, 'status')
      let stopReason: 'end' | 'cancelled' | 'error'
      switch (status) {
        case 'completed':
          stopReason = 'end'
          break
        case 'interrupted':
          stopReason = 'cancelled'
          break
        case 'failed':
          stopReason = 'error'
          break
        default:
          return []
      }
      const done: AgentEvent = { type: 'turn.done', turnId, stopReason, at: timestamp(turn, 'completedAt') }
      return status === 'failed' ? [failure(turnId, sub(turn, 'error'), false), done] : [done]
    }
    case 'item/agentMessage/delta': {
      const text = str(params, 'delta')
      return text === undefined ? [] : [{ type: 'text.delta', turnId, text }]
    }
    case 'item/started':
    case 'item/completed': {
      const item = sub(params, 'item')
      if (item === undefined) return []
      if (call.method === 'item/started' || str(item, 'type') !== 'agentMessage') {
        return codexItemEvents(item, turnId, call.method === 'item/started')
      }
      const text = str(item, 'text')
      return text === undefined ? [] : [{ type: 'text.done', turnId, text }]
    }
    case 'thread/tokenUsage/updated': {
      const tokenUsage = sub(params, 'tokenUsage') ?? {}
      const total = sub(tokenUsage, 'total') ?? {}
      const inputTokens = num(total, 'inputTokens')
      const outputTokens = num(total, 'outputTokens')
      if (inputTokens === undefined || outputTokens === undefined) return []
      return [
        {
          type: 'usage',
          turnId,
          inputTokens,
          outputTokens,
          scope: 'thread',
          contextWindowTokens: num(tokenUsage, 'modelContextWindow'),
          cacheReadInputTokens: num(total, 'cachedInputTokens'),
          cacheWriteInputTokens: num(total, 'cacheWriteInputTokens')
        }
      ]
    }
    case 'error':
      return [failure(turnId, sub(params, 'error'), params['willRetry'] === true)]
    default:
      return []
  }
}
