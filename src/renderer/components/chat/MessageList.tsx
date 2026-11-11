import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentEvent, FilePatch } from '../../../shared/events'
import { isTurnRunning } from '../../state/sessions'
import { deriveBlocks, type Block } from '../../../shared/blocks'
import { usageByTurn } from '../../../shared/usage'
import { ChatEmptyState } from './ChatEmptyState'
import { QuestionCard } from './QuestionCard'
import {
  AssistantText,
  ErrorRow,
  ReasoningBlock,
  SubagentRow,
  ThinkingRow,
  ToolRow,
  TurnGroupHeader,
  TurnMeta,
  UserBubble
} from './MessageBlocks'
import { groupTurns, metaLabel, observe, timeline, type AssistantTurn } from './transcript'
import './chat.css'

type FileOpen = (path: string, line?: number) => void

/** Follow yields once the user scrolls more than this far above the bottom. */
const FOLLOW_SLACK = 80

/** Event data that deriveBlocks drops (patches, error codes), indexed for rendering. */
function sideData(events: AgentEvent[], blocks: Block[]) {
  const patches = new Map<string, FilePatch[]>()
  const codes: string[] = []
  for (const event of events) {
    if (event.type === 'tool.result' && event.patches !== undefined && event.patches.length > 0) {
      patches.set(event.callId, event.patches)
    } else if (event.type === 'error') {
      codes.push(event.code)
    }
  }
  // Error blocks are emitted one per error event, in order.
  const errorCodes = new Map<string, string>()
  let index = 0
  for (const block of blocks) {
    if (block.kind !== 'error') continue
    const code = codes[index++]
    if (code !== undefined) errorCodes.set(block.id, code)
  }
  return { patches, errorCodes }
}

export function MessageList({
  sessionId,
  events,
  onFileOpen,
  onPrompt
}: {
  sessionId?: string | undefined
  events: AgentEvent[]
  onFileOpen?: FileOpen
  onPrompt?: (text: string) => void
}) {
  observe(events)
  const blocks = useMemo(() => deriveBlocks(events), [events])
  const segments = useMemo(() => groupTurns(blocks), [blocks])
  const lastSegmentByTurn = useMemo(() => {
    const result = new Map<string, AssistantTurn>()
    for (const segment of segments)
      if (segment.kind === 'turn' && segment.turnId !== undefined) result.set(segment.turnId, segment)
    return result
  }, [segments])
  const side = useMemo(() => sideData(events, blocks), [events, blocks])
  const times = useMemo(() => timeline(events), [events])
  const usage = useMemo(() => usageByTurn(events), [events])
  const running = isTurnRunning(events)

  // Per-turn open overrides, keyed with the running flag so a turn re-collapses on turn.done.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})

  const listRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const headRef = useRef<AgentEvent | undefined>(undefined)
  useLayoutEffect(() => {
    // Opening another session starts at its bottom again.
    if (headRef.current !== events[0]) {
      headRef.current = events[0]
      followRef.current = true
    }
    const el = listRef.current
    if (el !== null && followRef.current) el.scrollTop = el.scrollHeight
  }, [events])

  useLayoutEffect(() => {
    const el = listRef.current
    const column = el?.firstElementChild
    if (!running || el === null || column === undefined || column === null) return
    // Image loads and width changes can grow Markdown without appending an event.
    const observer = new ResizeObserver(() => {
      if (followRef.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(column)
    return () => observer.disconnect()
  }, [running])

  if (events.length === 0) return <ChatEmptyState onPrompt={onPrompt} />

  const last = segments.at(-1)
  const liveTurn =
    running && last?.kind === 'turn' && (last.turnId === undefined || !times.done.has(last.turnId))
      ? last
      : undefined
  const thinking = running && liveTurn === undefined

  const renderItem = (block: Block, live: boolean, streaming: boolean): ReactNode => {
    switch (block.kind) {
      case 'question':
        if (block.resolved || block.answers !== undefined) return null
        return (
          <QuestionCard
            key={block.id}
            request={block.request}
            sessionId={sessionId}
            answers={block.answers}
            followUp={times.done.has(block.turnId) && !block.request.blocking}
            disabled={block.resolved || (times.done.has(block.turnId) && block.request.blocking)}
          />
        )
      case 'text':
        if (block.text === '') return null
        return (
          <AssistantText key={block.id} text={block.text} streaming={streaming} onFileOpen={onFileOpen} />
        )
      case 'reasoning':
        return <ReasoningBlock key={block.id} text={block.text} />
      case 'tool':
        return <ToolRow key={block.id} block={block} patches={side.patches.get(block.id)} live={live} />
      case 'subagent':
        return <SubagentRow key={block.id} block={block} live={live} onFileOpen={onFileOpen} />
      case 'error':
        return <ErrorRow key={block.id} message={block.message} code={side.errorCodes.get(block.id)} />
      case 'user':
        return null
    }
  }

  const renderTurn = (turn: AssistantTurn): ReactNode => {
    const activity = turn.items.filter((block) => block.kind !== 'question')
    const questions = turn.items.filter((block) => block.kind === 'question')
    const live = turn === liveTurn
    const grouped = turn.toolCount + turn.messageCount + turn.subagentCount > 0
    const overrideKey = `${turn.key}:${live ? 'live' : 'done'}`
    const open = overrides[overrideKey] ?? live
    const streamingId = live
      ? (turn.final?.id ?? turn.items.findLast((b) => b.kind === 'text')?.id)
      : undefined
    const timing = turn.turnId === undefined ? undefined : times.byTurn.get(turn.turnId)
    return (
      <section key={turn.key} className="chat-turn">
        {grouped ? (
          <div className="chat-group">
            <TurnGroupHeader
              turn={turn}
              open={open}
              onToggle={() => setOverrides((prev) => ({ ...prev, [overrideKey]: !open }))}
            />
            {open && (
              <div className="chat-group-body chat-reveal">
                {activity.map((block) => renderItem(block, live, block.id === streamingId))}
              </div>
            )}
          </div>
        ) : (
          activity.map((block) => renderItem(block, live, block.id === streamingId))
        )}
        {questions.map((block) => renderItem(block, live, false))}
        {turn.final !== undefined && renderItem(turn.final, live, turn.final.id === streamingId)}
        {!live && (turn.turnId === undefined || lastSegmentByTurn.get(turn.turnId) === turn) && (
          <TurnMeta
            label={metaLabel(timing)}
            copyText={turn.final?.text || undefined}
            usage={usage.get(turn.turnId ?? '')}
          />
        )}
      </section>
    )
  }

  return (
    <div
      ref={listRef}
      className="chat-list"
      onScroll={(e) => {
        const el = e.currentTarget
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK
      }}
    >
      <div className="chat-column">
        {segments.map((segment) =>
          segment.kind === 'user' ? (
            <UserBubble key={segment.key} text={segment.block.text} onFileOpen={onFileOpen} />
          ) : (
            renderTurn(segment)
          )
        )}
        {thinking && <ThinkingRow since={times.lastBoundaryAt} />}
      </div>
    </div>
  )
}
