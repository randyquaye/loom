import { randomUUID } from 'node:crypto'
import type { AgentEvent, FilePatch, ToolName } from '../../../shared/events'
import { errorEvent, isRec, list, num, str, sub, tryParseRecord, type Rec } from './record'

/** Used when a line carries no turn identity of its own. */
export const CODEX_FALLBACK_TURN_ID = 'turn'

/**
 * codex stamps records with either an ISO `timestamp` or an `*_at_ms` epoch, and
 * which one appears depends on the record kind. Missing stamps read as 0 so a
 * fixture replay stays deterministic instead of leaking Date.now() into events.
 */
function readAt(source: Rec): number {
  const stamp = source['timestamp']
  if (typeof stamp === 'number' && Number.isFinite(stamp)) return stamp
  if (typeof stamp === 'string') {
    const parsed = Date.parse(stamp)
    if (!Number.isNaN(parsed)) return parsed
  }
  return num(source, 'started_at_ms') ?? num(source, 'completed_at_ms') ?? num(source, 'at_ms') ?? 0
}

const CODEX_TOOL_ITEMS: Partial<Record<string, ToolName>> = {
  command_execution: 'bash',
  file_change: 'edit_file'
}

function toolNameFor(itemType: string | undefined): ToolName | undefined {
  return itemType === undefined ? undefined : CODEX_TOOL_ITEMS[itemType]
}

function callIdOf(event: Rec, item: Rec): string {
  return str(item, 'id') ?? str(event, 'id') ?? str(item, 'call_id') ?? 'call'
}

function commandArgs(item: Rec): Rec {
  const args: Rec = {}
  const command = str(item, 'command')
  if (command !== undefined) args['command'] = command
  const cwd = str(item, 'cwd')
  if (cwd !== undefined) args['cwd'] = cwd
  return args
}

const PATCH_KINDS: Record<string, FilePatch['kind']> = {
  add: 'create',
  create: 'create',
  update: 'modify',
  modify: 'modify',
  move: 'modify',
  delete: 'delete'
}

function readPatches(item: Rec): FilePatch[] {
  const patches: FilePatch[] = []
  for (const change of list(item, 'changes')) {
    const path = str(change, 'path')
    if (path === undefined) continue
    const rawKind = str(change, 'kind') ?? 'update'
    patches.push({
      path,
      kind: PATCH_KINDS[rawKind] ?? 'modify',
      diff: str(change, 'unified_diff') ?? ''
    })
  }
  return patches
}

/** reasoning arrives under several field names across codex versions. */
function reasoningText(item: Rec): string {
  const summaryText = str(item, 'summary_text')
  if (summaryText !== undefined) return summaryText
  const rawContent = str(item, 'raw_content')
  if (rawContent !== undefined) return rawContent
  const parts = list(item, 'text')
  const joined = parts
    .map((part) => str(part, 'text'))
    .filter((piece): piece is string => piece !== undefined)
    .join('')
  return joined || str(item, 'text') || ''
}

function commandOutput(item: Rec): string {
  const aggregated = str(item, 'aggregated_output')
  if (aggregated !== undefined) return aggregated
  const stdout = str(item, 'stdout') ?? ''
  const stderr = str(item, 'stderr') ?? ''
  return stderr.length > 0 ? `${stdout}${stdout.length > 0 ? '\n' : ''}${stderr}` : stdout
}

function commandSucceeded(item: Rec): boolean {
  const exitCode = num(item, 'exit_code')
  if (exitCode !== undefined) return exitCode === 0
  return (str(item, 'status') ?? 'completed') === 'completed'
}

function itemCompletedEvents(event: Rec, item: Rec, turnId: string): AgentEvent[] {
  const itemType = str(item, 'type')
  const callId = callIdOf(event, item)
  switch (itemType) {
    case 'agent_message': {
      const text = str(item, 'text') ?? ''
      return text.length > 0 ? [{ type: 'text.done', turnId, text }] : []
    }
    case 'reasoning': {
      const text = reasoningText(item)
      return text.length > 0 ? [{ type: 'reasoning.delta', turnId, text }] : []
    }
    case 'command_execution':
      return [
        { type: 'tool.result', turnId, callId, ok: commandSucceeded(item), output: commandOutput(item) }
      ]
    case 'file_change': {
      const patches = readPatches(item)
      const result: AgentEvent = {
        type: 'tool.result',
        turnId,
        callId,
        ok: commandSucceeded(item),
        output: commandOutput(item)
      }
      if (patches.length > 0) {
        return [{ ...result, patches }]
      }
      return [result]
    }
    // mcp_tool_call / web_search / todo_list and any item kind codex adds later:
    // close the generic row opened at item.started with whatever text it carries.
    default:
      return [
        {
          type: 'tool.result',
          turnId,
          callId,
          ok: commandSucceeded(item),
          output: reasoningText(item)
        }
      ]
  }
}

function usageOf(event: Rec): { inputTokens: number; outputTokens: number } {
  const usage = sub(event, 'usage') ?? event
  return {
    inputTokens: num(usage, 'input_tokens') ?? num(usage, 'total_input_tokens') ?? 0,
    outputTokens: num(usage, 'output_tokens') ?? num(usage, 'total_output_tokens') ?? 0
  }
}

interface Failure {
  code: string
  message: string
  retryable: boolean
}

/**
 * Failure detail lives either on a nested `error` object or directly on the
 * envelope. The envelope's own `type` is never a usable code (it is literally
 * "error"/"turn.failed"), so it is only read from the nested object.
 */
function describeFailure(event: Rec, fallbackCode: string): Failure {
  const nested = sub(event, 'error')
  const code =
    str(event, 'code') ?? (nested ? (str(nested, 'code') ?? str(nested, 'type')) : undefined) ?? fallbackCode
  const message =
    (nested ? str(nested, 'message') : undefined) ?? str(event, 'message') ?? `codex reported ${code}`
  const retryable = (nested ? nested['will_retry'] : undefined) === true || event['will_retry'] === true
  return { code, message, retryable }
}

/**
 * Maps one `codex exec --json` JSONL record onto AgentEvents.
 *
 * Unknown record and item types are ignored; malformed JSON produces exactly one
 * error event. `turnId` is the fallback identity, overridden by a `turn_id` on
 * the record when codex supplies one.
 */
export function parseCodexJsonlLine(line: string, turnId: string = CODEX_FALLBACK_TURN_ID): AgentEvent[] {
  const trimmed = line.trim()
  if (trimmed.length === 0) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return [errorEvent(turnId, 'codex.malformed-json', `unparseable codex --json line: ${detail}`, false)]
  }
  if (!isRec(parsed)) return []

  const event = parsed
  // codex emits a per-turn turn_id, which is the correct turn identity; the
  // passed id is only the fallback for records that carry none. (claude differs:
  // its session_id is constant across turns, so its parser ignores it.)
  const resolvedTurn = str(event, 'turn_id') ?? turnId
  const itemType = str(event, 'type')

  switch (itemType) {
    case 'thread.started':
      return [{ type: 'turn.started', turnId: resolvedTurn, at: readAt(event) }]

    // codex emits turn.started immediately after thread.started for the same
    // turn; thread.started is the record that carries the resumable thread id,
    // so it owns the turn boundary and this one is a duplicate.
    case 'turn.started':
      return []

    case 'item.started': {
      const item = sub(event, 'item')
      if (!item) return []
      const itemType = str(item, 'type') ?? 'item'
      const name = toolNameFor(itemType)
      // Message and reasoning items are not tools; they surface at item.completed.
      if (name === undefined && (itemType === 'agent_message' || itemType === 'reasoning')) return []
      return [
        {
          type: 'tool.call',
          turnId: resolvedTurn,
          callId: callIdOf(event, item),
          // Unmapped kinds (mcp_tool_call, web_search, todo_list, whatever codex adds
          // next) become generic rows: a labelled row beats a hole in the transcript.
          name: name ?? itemType,
          args:
            name === 'bash'
              ? commandArgs(item)
              : itemType === 'web_search'
                ? item
                : (sub(item, 'arguments') ?? { changes: list(item, 'changes') })
        }
      ]
    }

    case 'item.updated': {
      const item = sub(event, 'item')
      if (!item || str(item, 'type') !== 'agent_message') return []
      // item.updated carries cumulative text in current codex builds; only an
      // explicit delta is safe to forward, otherwise the renderer would
      // re-append the whole message on every update.
      const delta = str(event, 'delta') ?? str(item, 'delta')
      return delta !== undefined && delta.length > 0
        ? [{ type: 'text.delta', turnId: resolvedTurn, text: delta }]
        : []
    }

    case 'item.completed': {
      const item = sub(event, 'item')
      return item ? itemCompletedEvents(event, item, resolvedTurn) : []
    }

    case 'turn.completed': {
      const { inputTokens, outputTokens } = usageOf(event)
      return [
        { type: 'usage', turnId: resolvedTurn, inputTokens, outputTokens },
        { type: 'turn.done', turnId: resolvedTurn, stopReason: 'end' }
      ]
    }

    case 'turn.failed': {
      const { code, message, retryable } = describeFailure(event, 'codex.turn-failed')
      return [
        errorEvent(resolvedTurn, code, message, retryable),
        { type: 'turn.done', turnId: resolvedTurn, stopReason: 'error' }
      ]
    }

    case 'error': {
      const { code, message, retryable } = describeFailure(event, 'codex.error')
      return [errorEvent(resolvedTurn, code, message, retryable)]
    }

    default:
      return []
  }
}

export interface CodexLineParser {
  parse(line: string): AgentEvent[]
  /** Provider thread id, once `thread.started` has been seen; used for resume. */
  threadId(): string | undefined
}

/**
 * Stateful wrapper used by the spawn layer: `thread.started` publishes the
 * resumable thread id, which then becomes the turn identity for every later
 * record in the same exec run.
 */
export function createCodexParser(turnId: string = randomUUID()): CodexLineParser {
  let thread: string | undefined
  let turnStarted = false

  return {
    parse(line: string): AgentEvent[] {
      // Read the record once, up front: the thread id on `thread.started` has to
      // be known before that same line is turned into a turn.started event.
      const record = tryParseRecord(line)
      if (record && thread === undefined) thread = str(record, 'thread_id')

      const events = parseCodexJsonlLine(line, turnId)

      // A stream that opens with turn.started (resume runs) never sees
      // thread.started, so the turn boundary is synthesized here instead,
      // preferring the record's own turn_id so it matches the rest of the turn.
      if (record && !turnStarted && str(record, 'type') === 'turn.started') {
        events.unshift({
          type: 'turn.started',
          turnId: str(record, 'turn_id') ?? turnId,
          at: readAt(record)
        })
      }
      if (events.some((e) => e.type === 'turn.started')) turnStarted = true
      return events
    },
    threadId() {
      return thread
    }
  }
}
