import type { AgentEvent, QuestionAnswer, QuestionRequest, SessionMessageOrigin } from './events'

/** turnId is the producing event's turn (additive; absent on turn-less errors), used to group a turn. */
export type Block =
  | {
      kind: 'question'
      id: string
      turnId: string
      request: QuestionRequest
      resolved: boolean
      answers?: QuestionAnswer['answers']
    }
  | { kind: 'user'; id: string; text: string; turnId?: string; peer?: SessionMessageOrigin }
  | { kind: 'text'; id: string; text: string; turnId?: string }
  | { kind: 'reasoning'; id: string; text: string; turnId?: string }
  | {
      kind: 'tool'
      id: string
      name: string
      args: unknown
      output?: string
      ok?: boolean
      turnId?: string
    }
  | {
      kind: 'subagent'
      id: string
      description: string
      prompt?: string
      taskId?: string
      subagentType?: string
      backgrounded?: boolean
      depth?: number
      tokens?: number
      toolUses?: number
      durationMs?: number
      lastTool?: string
      /** Undefined while running; set when the subagent ends. */
      ok?: boolean
      report?: string
      turnId?: string
    }
  | { kind: 'error'; id: string; message: string; turnId?: string }

/** Folds the flat event stream into renderable blocks, merging deltas per turn. */
export function deriveBlocks(events: AgentEvent[]): Block[] {
  const blocks: Block[] = []
  const textByTurn = new Map<string, Extract<Block, { kind: 'text' }>>()
  const reasonByTurn = new Map<string, Extract<Block, { kind: 'reasoning' }>>()
  const toolByCall = new Map<string, Extract<Block, { kind: 'tool' }>>()
  const subagentByCall = new Map<string, Extract<Block, { kind: 'subagent' }>>()
  const questions = new Map<string, Extract<Block, { kind: 'question' }>>()

  for (const event of events) {
    switch (event.type) {
      case 'turn.done': {
        const last = blocks.at(-1)
        // A silent/cancelled turn still owns metadata, even when guidance was its last row.
        if (
          last === undefined ||
          last.kind === 'user' ||
          (last.turnId !== undefined && last.turnId !== event.turnId)
        ) {
          blocks.push({
            kind: 'text',
            id: `text-${event.turnId}-${blocks.length}`,
            text: '',
            turnId: event.turnId
          })
        }
        break
      }
      case 'question.requested': {
        const block: Extract<Block, { kind: 'question' }> = {
          kind: 'question',
          id: event.requestId,
          turnId: event.turnId,
          request: event,
          resolved: false
        }
        questions.set(event.requestId, block)
        blocks.push(block)
        textByTurn.delete(event.turnId)
        break
      }
      case 'question.resolved': {
        const block = questions.get(event.requestId)
        if (block !== undefined) block.resolved = true
        break
      }
      case 'question.answered': {
        const block = questions.get(event.requestId)
        if (block !== undefined) block.answers = event.answers
        break
      }
      case 'user.text':
      case 'user.steer':
        blocks.push({
          kind: 'user',
          id: `user-${event.turnId}-${blocks.length}`,
          text: event.text,
          turnId: event.turnId,
          ...(event.type === 'user.text' && event.peer !== undefined ? { peer: event.peer } : {})
        })
        if (event.type === 'user.steer') textByTurn.delete(event.turnId)
        break
      case 'text.delta': {
        let block = textByTurn.get(event.turnId)
        if (block === undefined) {
          block = {
            kind: 'text',
            id: `text-${event.turnId}-${blocks.length}`,
            text: '',
            turnId: event.turnId
          }
          textByTurn.set(event.turnId, block)
          blocks.push(block)
        }
        block.text += event.text
        break
      }
      case 'text.done': {
        const existing = textByTurn.get(event.turnId)
        if (existing === undefined) {
          const block: Extract<Block, { kind: 'text' }> = {
            kind: 'text',
            id: `text-${event.turnId}-${blocks.length}`,
            text: event.text,
            turnId: event.turnId
          }
          textByTurn.set(event.turnId, block)
          blocks.push(block)
        } else {
          existing.text = event.text
        }
        break
      }
      case 'reasoning.delta': {
        let block = reasonByTurn.get(event.turnId)
        if (block === undefined) {
          block = { kind: 'reasoning', id: `reason-${event.turnId}`, text: '', turnId: event.turnId }
          reasonByTurn.set(event.turnId, block)
          blocks.push(block)
        }
        block.text += event.text
        break
      }
      case 'tool.call': {
        const block: Extract<Block, { kind: 'tool' }> = {
          kind: 'tool',
          id: event.callId,
          name: event.name,
          args: event.args,
          turnId: event.turnId
        }
        toolByCall.set(event.callId, block)
        blocks.push(block)
        // Closing the turn's text block here means a later response starts a
        // new block instead of overwriting the pre-tool answer.
        textByTurn.delete(event.turnId)
        break
      }
      case 'tool.result': {
        const block = toolByCall.get(event.callId)
        if (block !== undefined) {
          block.output = event.output
          block.ok = event.ok
        }
        break
      }
      case 'subagent.start': {
        const block: Extract<Block, { kind: 'subagent' }> = {
          kind: 'subagent',
          id: event.callId,
          description: event.description,
          ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
          turnId: event.turnId
        }
        subagentByCall.set(event.callId, block)
        blocks.push(block)
        textByTurn.delete(event.turnId)
        break
      }
      case 'subagent.meta': {
        const block = subagentByCall.get(event.callId)
        if (block === undefined) break
        if (event.taskId !== undefined) block.taskId = event.taskId
        if (event.subagentType !== undefined) block.subagentType = event.subagentType
        if (event.backgrounded !== undefined) block.backgrounded = event.backgrounded
        if (event.depth !== undefined) block.depth = event.depth
        break
      }
      case 'subagent.progress': {
        const block = subagentByCall.get(event.callId)
        if (block === undefined) break
        if (event.tokens !== undefined) block.tokens = event.tokens
        if (event.toolUses !== undefined) block.toolUses = event.toolUses
        if (event.durationMs !== undefined) block.durationMs = event.durationMs
        if (event.lastTool !== undefined) block.lastTool = event.lastTool
        break
      }
      case 'subagent.end': {
        const block = subagentByCall.get(event.callId)
        if (block === undefined) break
        block.ok = event.ok
        if (event.durationMs !== undefined) block.durationMs = event.durationMs
        if (event.report !== undefined) block.report = event.report
        break
      }
      case 'error':
        blocks.push({
          kind: 'error',
          id: `error-${blocks.length}`,
          message: event.message,
          ...(event.turnId === undefined ? {} : { turnId: event.turnId })
        })
        break
      default:
        break
    }
  }
  return blocks
}
