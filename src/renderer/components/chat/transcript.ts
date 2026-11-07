import type { AgentEvent } from '../../../shared/events'
import type { Block } from './derive'

export type TextBlock = Extract<Block, { kind: 'text' }>
export type ToolBlock = Extract<Block, { kind: 'tool' }>
export type UserBlock = Extract<Block, { kind: 'user' }>
export type SubagentBlock = Extract<Block, { kind: 'subagent' }>

export type ToolKind = 'bash' | 'grep' | 'glob' | 'read' | 'write' | 'edit' | 'other'

/** One assistant turn: intermediate work (text, reasoning, tools, errors) plus its final answer. */
export interface AssistantTurn {
  kind: 'turn'
  key: string
  turnId: string | undefined
  /** Everything except the final answer, in arrival order. */
  items: Block[]
  /** The trailing text block, rendered flat below the group. */
  final: TextBlock | undefined
  toolCount: number
  messageCount: number
  /** Spawned subagents; counted apart from tool calls and messages. */
  subagentCount: number
  /** Distinct tool kinds in order of first use, for the header icons. */
  toolKinds: ToolKind[]
}

export type Segment = { kind: 'user'; key: string; block: UserBlock } | AssistantTurn

export function toolKind(name: string): ToolKind {
  switch (name) {
    case 'bash':
      return 'bash'
    case 'grep':
      return 'grep'
    case 'glob':
      return 'glob'
    case 'read_file':
      return 'read'
    case 'write_file':
      return 'write'
    case 'edit_file':
      return 'edit'
    default:
      return 'other'
  }
}

function finalize(turn: AssistantTurn): void {
  const last = turn.items.at(-1)
  if (last?.kind === 'text') {
    turn.final = last
    turn.items = turn.items.slice(0, -1)
  }
  for (const item of turn.items) {
    if (item.kind === 'tool') {
      turn.toolCount++
      const kind = toolKind(item.name)
      if (!turn.toolKinds.includes(kind)) turn.toolKinds.push(kind)
    } else if (item.kind === 'text') {
      turn.messageCount++
    } else if (item.kind === 'subagent') {
      turn.subagentCount++
    }
  }
}

/**
 * Splits blocks into user turns and assistant turns. User prompts and the agent's
 * turn carry different turn ids (the adapter mints its own), so an assistant turn
 * is "everything after a user prompt that shares a turn id"; turn-less blocks
 * (errors without a turnId) join the turn they arrive in.
 */
export function groupTurns(blocks: Block[]): Segment[] {
  const out: Segment[] = []
  let current: AssistantTurn | undefined
  for (const block of blocks) {
    if (block.kind === 'user') {
      out.push({ kind: 'user', key: block.id, block })
      current = undefined
      continue
    }
    const turnId = block.turnId
    if (
      current === undefined ||
      (turnId !== undefined && current.turnId !== undefined && turnId !== current.turnId)
    ) {
      current = {
        kind: 'turn',
        key: `turn-${block.id}`,
        turnId,
        items: [],
        final: undefined,
        toolCount: 0,
        messageCount: 0,
        subagentCount: 0,
        toolKinds: []
      }
      out.push(current)
    }
    if (current.turnId === undefined) current.turnId = turnId
    current.items.push(block)
  }
  for (const segment of out) if (segment.kind === 'turn') finalize(segment)
  return out
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function groupLabel(turn: AssistantTurn): string {
  const parts: string[] = []
  if (turn.toolCount > 0) parts.push(plural(turn.toolCount, 'tool call'))
  if (turn.messageCount > 0) parts.push(plural(turn.messageCount, 'message'))
  if (turn.subagentCount > 0) parts.push(plural(turn.subagentCount, 'subagent'))
  return parts.join(', ')
}

/* ---------- tool rows ---------- */

function field(args: unknown, ...keys: string[]): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const rec = args as Record<string, unknown>
  for (const key of keys) {
    const value = rec[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Paths named by an edit: loop/claude carry a path, codex carries a list of changes. */
function paths(args: unknown): string | undefined {
  const direct = field(args, 'file_path', 'path', 'notebook_path')
  if (direct !== undefined) return direct
  if (typeof args !== 'object' || args === null) return undefined
  const changes = (args as Record<string, unknown>)['changes']
  if (!Array.isArray(changes)) return undefined
  const list = changes
    .map((change) => field(change, 'path', 'file_path'))
    .filter((p): p is string => p !== undefined)
  return list.length === 0 ? undefined : list.join(', ')
}

/** codex wraps every command as `/bin/zsh -lc "…"`; the chip shows the command itself. */
export function unwrapShell(command: string): string {
  const match = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1\s*$/.exec(command.trim())
  if (match === null) return command
  const body = match[2] as string
  return match[1] === '"' ? body.replace(/\\(["\\$`])/g, '$1') : body
}

export function firstLine(text: string | undefined): string {
  if (text === undefined) return ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

function countLines(output: string | undefined): number {
  if (output === undefined || /^(?:\(no matches\)|no (?:matches|files)(?: found)?\.?)$/i.test(output.trim()))
    return 0
  return output.split('\n').filter((line) => line.trim() !== '').length
}

function compactArgs(args: unknown): string | undefined {
  if (args === undefined) return undefined
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return undefined
  }
}

export interface ToolSummary {
  kind: ToolKind
  /** Sans label ("Bash", "grep for 'x'"). */
  label: string
  /** Mono target after "in" (grep/glob scope). */
  target?: string | undefined
  /** Mono argument chip, truncated with ellipsis. */
  chip?: string | undefined
  /** Faint result suffix ("12 matches"). */
  suffix?: string | undefined
}

export function toolSummary(block: ToolBlock): ToolSummary {
  const kind = toolKind(block.name)
  const done = block.ok === true
  switch (kind) {
    case 'bash': {
      const command = field(block.args, 'command', 'cmd')
      return { kind, label: 'Bash', chip: command === undefined ? undefined : unwrapShell(command) }
    }
    case 'grep':
    case 'glob': {
      const pattern = field(block.args, 'pattern', 'query') ?? ''
      const target = field(block.args, 'path', 'dir', 'cwd')
      const n = countLines(block.output)
      const [one, many] = kind === 'grep' ? ['match', 'matches'] : ['file', 'files']
      const suffix = n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`
      return { kind, label: `${kind} for '${pattern}'`, target, suffix: done ? suffix : undefined }
    }
    case 'read':
      return { kind, label: 'Read', chip: paths(block.args) }
    case 'write':
      return { kind, label: 'Write', chip: paths(block.args) }
    case 'edit':
      return { kind, label: 'Edit', chip: paths(block.args) }
    default:
      return { kind, label: block.name, chip: compactArgs(block.args) }
  }
}

/* ---------- timing ---------- */

/**
 * Persisted events carry no timestamps, so arrival times are observed here: an
 * event is "live" when it is appended to an array this list already rendered
 * (same head event, longer tail). History loaded in one go stays unstamped, so a
 * turn's meta row only claims a duration it actually witnessed.
 */
const liveAt = new WeakMap<AgentEvent, number>()
const firstSeenAt = new WeakMap<AgentEvent, number>()
const lastRenderedByHead = new WeakMap<AgentEvent, number>()

export function observe(events: AgentEvent[]): void {
  const head = events[0]
  if (head === undefined) return
  const now = Date.now()
  const prevLength = lastRenderedByHead.get(head)
  if (prevLength !== undefined) {
    for (let i = prevLength; i < events.length; i++) {
      const event = events[i] as AgentEvent
      if (!liveAt.has(event)) liveAt.set(event, now)
    }
  }
  for (const event of events) if (!firstSeenAt.has(event)) firstSeenAt.set(event, now)
  lastRenderedByHead.set(head, events.length)
}

export interface TurnTiming {
  startedAt?: number | undefined
  doneAt?: number | undefined
}

function epochMs(at: number): number | undefined {
  if (at > 1e12) return at
  if (at > 1e9) return at * 1000
  return undefined
}

export interface Timeline {
  byTurn: Map<string, TurnTiming>
  done: Set<string>
  /** When the newest turn boundary (user.text / turn.started) was first seen, for the Thinking row. */
  lastBoundaryAt: number | undefined
}

export function timeline(events: AgentEvent[]): Timeline {
  const byTurn = new Map<string, TurnTiming>()
  const done = new Set<string>()
  let lastUserLive: number | undefined
  let lastBoundaryAt: number | undefined
  const timing = (turnId: string): TurnTiming => {
    let entry = byTurn.get(turnId)
    if (entry === undefined) {
      entry = lastUserLive === undefined ? {} : { startedAt: lastUserLive }
      byTurn.set(turnId, entry)
    }
    return entry
  }
  for (const event of events) {
    switch (event.type) {
      case 'user.text':
        lastUserLive = liveAt.get(event)
        lastBoundaryAt = liveAt.get(event) ?? firstSeenAt.get(event)
        break
      case 'turn.started': {
        const entry = timing(event.turnId)
        entry.startedAt = epochMs(event.at) ?? liveAt.get(event) ?? entry.startedAt
        lastBoundaryAt = entry.startedAt ?? lastBoundaryAt ?? firstSeenAt.get(event)
        break
      }
      case 'turn.done': {
        done.add(event.turnId)
        const at = (event.at === undefined ? undefined : epochMs(event.at)) ?? liveAt.get(event)
        if (at !== undefined) timing(event.turnId).doneAt = at
        break
      }
      default:
        if ('turnId' in event && event.turnId !== undefined) timing(event.turnId)
        break
    }
  }
  return { byTurn, done, lastBoundaryAt }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const STAMP = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
})

export function formatStamp(at: number): string {
  return STAMP.format(at)
}

export function metaLabel(timing: TurnTiming | undefined): string | undefined {
  if (timing === undefined) return undefined
  const parts: string[] = []
  if (timing.startedAt !== undefined && timing.doneAt !== undefined) {
    parts.push(formatDuration(timing.doneAt - timing.startedAt))
  }
  const at = timing.doneAt ?? timing.startedAt
  if (at !== undefined) parts.push(formatStamp(at))
  return parts.length === 0 ? undefined : parts.join(' · ')
}
