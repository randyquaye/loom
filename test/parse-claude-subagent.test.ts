import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createClaudeParser } from '../src/main/agents/cli/parse-claude'
import type { AgentEvent } from '../src/shared/events'

const FIXTURE = path.join(__dirname, 'fixtures', 'claude-subagent-capture.jsonl')
const CALL = 'toolu_fixture0000'

/**
 * A real `claude -p --output-format stream-json --verbose` run that spawned exactly one
 * subagent, redacted. Pinned here so the subagent mapping is tested against the wire
 * format claude actually emits, not against a hand-written approximation of it.
 */
function capturedEvents(): AgentEvent[] {
  const parser = createClaudeParser('turn-1')
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .flatMap((line) => parser.parse(line))
}

describe('claude subagent lifecycle from a live capture', () => {
  it('emits start, meta, progress and end, in order, for the spawned subagent', () => {
    const sub = capturedEvents().filter((event) => event.type.startsWith('subagent.'))
    expect(sub.map((event) => event.type)).toEqual([
      'subagent.start',
      'subagent.meta',
      'subagent.progress',
      'subagent.end'
    ])
  })

  it('carries the description and prompt from the spawn call', () => {
    const start = capturedEvents().find((event) => event.type === 'subagent.start')
    expect(start).toMatchObject({
      callId: CALL,
      description: 'Reply with DONE',
      prompt: 'Reply with the single word DONE and nothing else.'
    })
  })

  it('carries type, backgrounding and depth from task_started', () => {
    const meta = capturedEvents().find((event) => event.type === 'subagent.meta')
    expect(meta).toMatchObject({
      callId: CALL,
      taskId: 'fixture-task',
      subagentType: 'general-purpose',
      backgrounded: false,
      depth: 1
    })
  })

  it('carries live usage from task_progress', () => {
    const progress = capturedEvents().find((event) => event.type === 'subagent.progress')
    expect(progress).toMatchObject({
      callId: CALL,
      tokens: 20986,
      toolUses: 1,
      durationMs: 1251,
      lastTool: 'SubagentHandback'
    })
  })

  it('ends once, ok, with the handback message as the report', () => {
    const events = capturedEvents()
    const ends = events.filter((event) => event.type === 'subagent.end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ callId: CALL, ok: true, report: 'DONE' })
  })

  it('leaves no orphan tool rows for the spawn or the handback plumbing', () => {
    const toolRows = capturedEvents().filter(
      (event) => event.type === 'tool.call' || event.type === 'tool.result'
    )
    expect(toolRows).toEqual([])
  })
})
