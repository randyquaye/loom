import { randomUUID } from 'node:crypto'
import type { AgentEvent, ToolName } from '../../../shared/events'
import { errorEvent, isRec, list, num, str, sub, tryParseRecord, type Rec } from './record'

/** Used when a record carries no `session_id` of its own. */
export const CLAUDE_FALLBACK_TURN_ID = 'turn'

/** claude names its built-in tools in PascalCase; AgentEvent's vocabulary is not. */
const CLAUDE_TOOLS: Record<string, ToolName> = {
  Bash: 'bash',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  NotebookEdit: 'edit_file',
  Glob: 'glob',
  Grep: 'grep'
}

/** Names claude has used for its subagent-spawning tool across versions. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])
/** The subagent's own report rides in this call; the parent's result only points at a file. */
const HANDBACK_TOOL = 'SubagentHandback'

/**
 * Cross-line memory for one stream: which calls spawned subagents, which task_id belongs
 * to which call, which subagents already ended, and the report waiting to be attached.
 * A pure per-line parser cannot see these relationships; they arrive on separate lines.
 */
export interface ClaudeParseState {
  subagentCalls: Set<string>
  /** SubagentHandback calls: internal plumbing whose results must not become rows. */
  handbackCalls: Set<string>
  callByTask: Map<string, string>
  ended: Set<string>
  pendingReport: string | null
}

export function createClaudeParseState(): ClaudeParseState {
  return {
    subagentCalls: new Set(),
    handbackCalls: new Set(),
    callByTask: new Map(),
    ended: new Set(),
    pendingReport: null
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (isRec(block) ? str(block, 'text') : undefined))
      .filter((piece): piece is string => piece !== undefined)
      .join('')
  }
  if (isRec(content)) return str(content, 'text') ?? ''
  return ''
}

function toolResultEvents(record: Rec, turnId: string, state: ClaudeParseState): AgentEvent[] {
  const message = sub(record, 'message')
  const blocks = message ? list(message, 'content') : list(record, 'content')
  const events: AgentEvent[] = []
  for (const block of blocks) {
    if (str(block, 'type') !== 'tool_result') continue
    const callId = str(block, 'tool_use_id') ?? 'call'
    // The handback's own result is an acknowledgement, not work the user should see.
    if (state.handbackCalls.has(callId)) continue
    // A subagent's result ends its row; emitting a tool.result too would leave an
    // orphan row whose "output" is only a pointer at an output file.
    if (state.subagentCalls.has(callId)) {
      if (state.ended.has(callId)) continue
      state.ended.add(callId)
      const report = state.pendingReport ?? undefined
      state.pendingReport = null
      events.push({
        type: 'subagent.end',
        turnId,
        callId,
        ok: block['is_error'] !== true,
        ...(report !== undefined ? { report } : {})
      })
      continue
    }
    events.push({
      type: 'tool.result',
      turnId,
      callId,
      ok: block['is_error'] !== true,
      output: toolResultText(block['content'])
    })
  }
  return events
}

function assistantEvents(record: Rec, turnId: string, state: ClaudeParseState): AgentEvent[] {
  const message = sub(record, 'message')
  const blocks = message ? list(message, 'content') : list(record, 'content')
  const events: AgentEvent[] = []
  let text = ''
  let lastTextAt = -1

  for (const block of blocks) {
    switch (str(block, 'type')) {
      case 'text': {
        const piece = str(block, 'text') ?? ''
        if (piece.length === 0) break
        text += piece
        events.push({ type: 'text.delta', turnId, text: piece })
        lastTextAt = events.length - 1
        break
      }
      case 'thinking': {
        const thinking = str(block, 'thinking') ?? str(block, 'text') ?? ''
        if (thinking.length > 0) events.push({ type: 'reasoning.delta', turnId, text: thinking })
        break
      }
      case 'tool_use': {
        const rawName = str(block, 'name') ?? ''
        const callId = str(block, 'id') ?? 'call'
        const input = sub(block, 'input') ?? {}
        if (SUBAGENT_TOOLS.has(rawName)) {
          state.subagentCalls.add(callId)
          const prompt = str(input, 'prompt')
          events.push({
            type: 'subagent.start',
            turnId,
            callId,
            description: str(input, 'description') ?? prompt ?? rawName,
            ...(prompt !== undefined ? { prompt } : {})
          })
          break
        }
        if (rawName === HANDBACK_TOOL) {
          state.handbackCalls.add(callId)
          state.pendingReport = str(input, 'message') ?? null
          break
        }
        // Unmapped names become generic rows rather than holes in the transcript.
        events.push({
          type: 'tool.call',
          turnId,
          callId,
          name: CLAUDE_TOOLS[rawName] ?? rawName,
          args: input
        })
        break
      }
      default:
        break
    }
  }

  if (text.length > 0) {
    // text.done carries the whole message and belongs with the deltas that
    // built it, not after a trailing tool_use block.
    events.splice(lastTextAt + 1, 0, { type: 'text.done', turnId, text })
  }
  return events
}

/**
 * claude reports subagent lifecycle on system records: task_started links a task_id to the
 * Agent call that spawned it, task_progress carries live usage, task_updated and
 * task_notification close it. Everything but task_updated repeats the tool_use_id, which is
 * the row's key; task_updated is linked back through the task_id seen at start.
 */
function taskEvents(record: Rec, turnId: string, state: ClaudeParseState): AgentEvent[] {
  const subtype = str(record, 'subtype') ?? ''
  if (!subtype.startsWith('task_')) return []
  const taskId = str(record, 'task_id')
  const toolUseId = str(record, 'tool_use_id')

  if (subtype === 'task_started') {
    const callId = toolUseId ?? taskId ?? 'subagent'
    if (toolUseId !== undefined && taskId !== undefined) state.callByTask.set(taskId, toolUseId)
    state.subagentCalls.add(callId)
    const subagentType = str(record, 'subagent_type')
    const backgrounded = record['is_backgrounded']
    const depth = num(record, 'spawn_depth')
    return [
      {
        type: 'subagent.meta',
        turnId,
        callId,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(subagentType !== undefined ? { subagentType } : {}),
        ...(typeof backgrounded === 'boolean' ? { backgrounded } : {}),
        ...(depth !== undefined ? { depth } : {})
      }
    ]
  }

  const callId = toolUseId ?? (taskId !== undefined ? state.callByTask.get(taskId) : undefined)
  if (callId === undefined) return []

  if (subtype === 'task_progress') {
    const usage = sub(record, 'usage')
    const tokens = usage === undefined ? undefined : num(usage, 'total_tokens')
    const toolUses = usage === undefined ? undefined : num(usage, 'tool_uses')
    const durationMs = usage === undefined ? undefined : num(usage, 'duration_ms')
    const lastTool = str(record, 'last_tool_name')
    return [
      {
        type: 'subagent.progress',
        turnId,
        callId,
        ...(tokens !== undefined ? { tokens } : {}),
        ...(toolUses !== undefined ? { toolUses } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(lastTool !== undefined ? { lastTool } : {})
      }
    ]
  }

  if (subtype !== 'task_updated' && subtype !== 'task_notification') return []
  const status =
    subtype === 'task_updated' ? str(sub(record, 'patch') ?? {}, 'status') : str(record, 'status')
  if (status !== 'completed' && status !== 'failed') return []
  if (state.ended.has(callId)) return []
  state.ended.add(callId)
  const report = state.pendingReport ?? undefined
  state.pendingReport = null
  return [
    {
      type: 'subagent.end',
      turnId,
      callId,
      ok: status === 'completed',
      ...(report !== undefined ? { report } : {})
    }
  ]
}

type StopReason = Extract<AgentEvent, { type: 'turn.done' }>['stopReason']

const RESULT_STOP: Record<string, StopReason> = {
  success: 'end',
  error_max_turns: 'limit',
  error_during_execution: 'error',
  error_max_budget_usd: 'limit'
}

function resultEvents(record: Rec, turnId: string): AgentEvent[] {
  const events: AgentEvent[] = []
  const usage = sub(record, 'usage') ?? record
  const subtype = str(record, 'subtype') ?? 'success'
  const isError = record['is_error'] === true
  const stopReason = isError && subtype === 'success' ? 'error' : (RESULT_STOP[subtype] ?? 'error')

  if (stopReason !== 'end') {
    events.push({
      type: 'error',
      turnId,
      code: `claude.${subtype}`,
      message: str(record, 'result') ?? str(record, 'error') ?? `claude run ended with ${subtype}`,
      retryable: false
    })
  }
  events.push({
    type: 'usage',
    turnId,
    inputTokens: num(usage, 'input_tokens') ?? 0,
    outputTokens: num(usage, 'output_tokens') ?? 0
  })
  events.push({ type: 'turn.done', turnId, stopReason })
  return events
}

/**
 * Maps one `claude --output-format=stream-json` record onto AgentEvents.
 *
 * Unknown record types (stream_event, control_request/control_response, hook and
 * plugin chatter) are ignored; malformed JSON produces exactly one error event.
 */
export function parseClaudeStreamLine(
  line: string,
  turnId: string = CLAUDE_FALLBACK_TURN_ID,
  state: ClaudeParseState = createClaudeParseState()
): AgentEvent[] {
  const trimmed = line.trim()
  if (trimmed.length === 0) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return [
      errorEvent(turnId, 'claude.malformed-json', `unparseable claude stream-json line: ${detail}`, false)
    ]
  }
  if (!isRec(parsed)) return []

  switch (str(parsed, 'type')) {
    // The init record is the only place claude states the session id up front,
    // so it owns the turn boundary; other system records carry subagent lifecycle.
    case 'system':
      return str(parsed, 'subtype') === 'init'
        ? [{ type: 'turn.started', turnId, at: num(parsed, 'timestamp_ms') ?? 0 }]
        : taskEvents(parsed, turnId, state)
    case 'assistant':
      return assistantEvents(parsed, turnId, state)
    case 'user':
      return toolResultEvents(parsed, turnId, state)
    case 'result':
      return resultEvents(parsed, turnId)
    default:
      return []
  }
}

export interface ClaudeLineParser {
  parse(line: string): AgentEvent[]
  /** Provider session id, once seen; used to resume later turns. */
  sessionId(): string | undefined
}

/** Stateful wrapper for the spawn layer: keeps the session id for resume. */
export function createClaudeParser(turnId: string = randomUUID()): ClaudeLineParser {
  let session: string | undefined
  const state = createClaudeParseState()
  return {
    parse(line: string): AgentEvent[] {
      const events = parseClaudeStreamLine(line, turnId, state)
      // Malformed lines were already reported as events by the line parser.
      if (session === undefined) session = str(tryParseRecord(line) ?? {}, 'session_id')
      return events
    },
    sessionId() {
      return session
    }
  }
}
