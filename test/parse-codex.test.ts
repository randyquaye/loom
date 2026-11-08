import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CODEX_FALLBACK_TURN_ID,
  createCodexParser,
  parseCodexJsonlLine
} from '../src/main/agents/cli/parse-codex'
import { agentEvent, type AgentEvent } from '../src/shared/events'

const FIXTURE = fileURLToPath(new URL('./fixtures/codex-exec-sample.jsonl', import.meta.url))
const WORKTREE = '/Users/randyquaye/Library/Application Support/Loom/workspaces/loom/p3-cli'
const THREAD = '019c1f3a-7d2b-4a51-9c0e-2b6f8a4d1e77'

function fixtureLines(): string[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
}

function replay(lines: string[]): AgentEvent[] {
  const parser = createCodexParser(THREAD)
  return lines.flatMap((line) => parser.parse(line))
}

describe('codex fixture replay', () => {
  const events = replay(fixtureLines())

  it('has at least ten records to replay', () => {
    expect(fixtureLines().length).toBeGreaterThanOrEqual(10)
  })

  it('produces the exact normalized event sequence', () => {
    expect(events).toEqual([
      { type: 'turn.started', turnId: THREAD, at: Date.parse('2026-11-04T09:14:02.114Z') },
      {
        type: 'reasoning.delta',
        turnId: THREAD,
        text: 'The user wants the adapter modules listed, then read. One shell call answers the first half.'
      },
      {
        type: 'tool.call',
        turnId: THREAD,
        callId: 'item_1',
        name: 'bash',
        args: { command: 'ls -1 src/main/agents/cli', cwd: WORKTREE }
      },
      {
        type: 'tool.result',
        turnId: THREAD,
        callId: 'item_1',
        ok: true,
        output: 'args.ts\ncatalog.ts\nparse-codex.ts\nparse-claude.ts\nspawn.ts\n'
      },
      // todo_list arrives completed-without-started in this capture, so its generic result
      // has no call row to attach to; it stays in the stream and renders nothing.
      { type: 'tool.result', turnId: THREAD, callId: 'item_2', ok: true, output: '' },
      {
        type: 'tool.call',
        turnId: THREAD,
        callId: 'item_3',
        name: 'edit_file',
        args: { changes: [{ kind: 'add', path: 'src/main/agents/cli/probe.ts' }] }
      },
      {
        type: 'tool.result',
        turnId: THREAD,
        callId: 'item_3',
        ok: true,
        output: '',
        patches: [
          {
            path: 'src/main/agents/cli/probe.ts',
            kind: 'create',
            diff: "--- /dev/null\n+++ b/src/main/agents/cli/probe.ts\n@@ -0,0 +1,2 @@\n+export const CODEX_BIN = 'codex'\n"
          }
        ]
      },
      { type: 'text.delta', turnId: THREAD, text: 'Six modules now sit under' },
      {
        type: 'text.done',
        turnId: THREAD,
        text: 'Six modules now sit under src/main/agents/cli; the line buffer is src/main/agents/cli/spawn.ts:88.'
      },
      { type: 'usage', turnId: THREAD, inputTokens: 1842, outputTokens: 317 },
      { type: 'turn.done', turnId: THREAD, stopReason: 'end' }
    ])
  })

  it('emits only events the shared schema accepts', () => {
    for (const event of events) {
      expect(agentEvent.safeParse(event).success, JSON.stringify(event)).toBe(true)
    }
  })

  it('captures the thread id so a later turn can resume it', () => {
    const parser = createCodexParser()
    for (const line of fixtureLines()) parser.parse(line)
    expect(parser.threadId()).toBe(THREAD)
  })

  it('keys every event off the thread id rather than the fallback', () => {
    for (const event of events) {
      if ('turnId' in event) expect(event.turnId).toBe(THREAD)
    }
  })
})

describe('parseCodexJsonlLine tolerance', () => {
  it('ignores blank and whitespace-only lines', () => {
    expect(parseCodexJsonlLine('')).toEqual([])
    expect(parseCodexJsonlLine('   \n')).toEqual([])
  })

  it('turns malformed JSON into exactly one error event instead of throwing', () => {
    const events = parseCodexJsonlLine('{"type":"turn.started",,,}')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'error',
      turnId: CODEX_FALLBACK_TURN_ID,
      code: 'codex.malformed-json',
      message: expect.stringContaining('unparseable codex --json line'),
      retryable: false
    })
  })

  it('ignores valid JSON that is not an object', () => {
    for (const line of ['42', '"a string"', '[1,2,3]', 'null', 'true']) {
      expect(parseCodexJsonlLine(line), line).toEqual([])
    }
  })

  it('ignores unknown record types', () => {
    expect(parseCodexJsonlLine('{"type":"hook.started","id":"h1"}')).toEqual([])
    expect(parseCodexJsonlLine('{"type":"totally.new.record","payload":{}}')).toEqual([])
  })

  it('renders unmapped item kinds as generic rows instead of dropping them', () => {
    for (const itemType of ['mcp_tool_call', 'web_search', 'todo_list', 'image_generation']) {
      const item = { type: itemType, id: 'i1' }
      const started = JSON.stringify({
        type: 'item.started',
        id: 'i1',
        item
      })
      expect(parseCodexJsonlLine(started), itemType).toEqual([
        {
          type: 'tool.call',
          turnId: CODEX_FALLBACK_TURN_ID,
          callId: 'i1',
          name: itemType,
          // web_search keeps the whole item so the transcript row can show the query.
          args: itemType === 'web_search' ? item : { changes: [] }
        }
      ])
      const completed = JSON.stringify({
        type: 'item.completed',
        id: 'i1',
        item: { type: itemType, id: 'i1' }
      })
      expect(parseCodexJsonlLine(completed), itemType).toEqual([
        { type: 'tool.result', turnId: CODEX_FALLBACK_TURN_ID, callId: 'i1', ok: true, output: '' }
      ])
    }
  })

  it('does not forward cumulative item.updated text as a delta', () => {
    const cumulative = JSON.stringify({
      type: 'item.updated',
      id: 'i1',
      item: { type: 'agent_message', id: 'i1', text: 'the whole message so far' }
    })
    expect(parseCodexJsonlLine(cumulative)).toEqual([])

    const explicit = JSON.stringify({
      type: 'item.updated',
      id: 'i1',
      delta: ' so far',
      item: { type: 'agent_message', id: 'i1', text: 'the whole message so far' }
    })
    expect(parseCodexJsonlLine(explicit)).toEqual([
      { type: 'text.delta', turnId: CODEX_FALLBACK_TURN_ID, text: ' so far' }
    ])
  })

  it('uses the fallback turn id when the record carries none', () => {
    expect(parseCodexJsonlLine('{"type":"thread.started","thread_id":"t-9"}')).toEqual([
      { type: 'turn.started', turnId: CODEX_FALLBACK_TURN_ID, at: 0 }
    ])
  })

  it('prefers an explicit turn_id and an explicit default', () => {
    expect(parseCodexJsonlLine('{"type":"turn.completed","turn_id":"t-7"}')).toEqual([
      { type: 'usage', turnId: 't-7', inputTokens: 0, outputTokens: 0 },
      { type: 'turn.done', turnId: 't-7', stopReason: 'end' }
    ])
    expect(parseCodexJsonlLine('{"type":"turn.completed"}', 't-outer')).toEqual([
      { type: 'usage', turnId: 't-outer', inputTokens: 0, outputTokens: 0 },
      { type: 'turn.done', turnId: 't-outer', stopReason: 'end' }
    ])
  })

  it('maps turn.failed onto an error plus an errored turn boundary', () => {
    const line = JSON.stringify({
      type: 'turn.failed',
      error: { type: 'usage_limit_exceeded', message: 'Weekly limit reached', resets_at: 1799999999 }
    })
    expect(parseCodexJsonlLine(line)).toEqual([
      {
        type: 'error',
        turnId: CODEX_FALLBACK_TURN_ID,
        code: 'usage_limit_exceeded',
        message: 'Weekly limit reached',
        retryable: false
      },
      { type: 'turn.done', turnId: CODEX_FALLBACK_TURN_ID, stopReason: 'error' }
    ])
  })

  it('marks a retryable error as retryable', () => {
    const line = JSON.stringify({ type: 'error', message: 'stream disconnected', will_retry: true })
    expect(parseCodexJsonlLine(line)).toEqual([
      {
        type: 'error',
        turnId: CODEX_FALLBACK_TURN_ID,
        code: 'codex.error',
        message: 'stream disconnected',
        retryable: true
      }
    ])
  })

  it('reads a failed command as a not-ok tool result', () => {
    const started = JSON.stringify({
      type: 'item.started',
      id: 'c1',
      item: { type: 'command_execution', id: 'c1', command: 'pnpm typecheck' }
    })
    expect(parseCodexJsonlLine(started)).toEqual([
      {
        type: 'tool.call',
        turnId: CODEX_FALLBACK_TURN_ID,
        callId: 'c1',
        name: 'bash',
        args: { command: 'pnpm typecheck' }
      }
    ])

    const failed = JSON.stringify({
      type: 'item.completed',
      id: 'c1',
      item: {
        type: 'command_execution',
        id: 'c1',
        command: 'pnpm typecheck',
        aggregated_output: 'error TS2345',
        exit_code: 2,
        status: 'failed'
      }
    })
    expect(parseCodexJsonlLine(failed)).toEqual([
      { type: 'tool.result', turnId: CODEX_FALLBACK_TURN_ID, callId: 'c1', ok: false, output: 'error TS2345' }
    ])
  })

  it('maps file_change kinds onto patch kinds', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      id: 'f1',
      item: {
        type: 'file_change',
        id: 'f1',
        status: 'completed',
        changes: [
          { kind: 'update', path: 'a.ts', unified_diff: '@@ a @@' },
          { kind: 'delete', path: 'b.ts' },
          { kind: 'move', path: 'c.ts', move_path: 'd.ts' },
          { path: 'untyped.ts' }
        ]
      }
    })
    const events = parseCodexJsonlLine(line)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'tool.result',
      ok: true,
      patches: [
        { path: 'a.ts', kind: 'modify', diff: '@@ a @@' },
        { path: 'b.ts', kind: 'delete', diff: '' },
        { path: 'c.ts', kind: 'modify', diff: '' },
        { path: 'untyped.ts', kind: 'modify', diff: '' }
      ]
    })
  })

  it('reads reasoning from whichever field the build uses', () => {
    const legacy = JSON.stringify({
      type: 'item.completed',
      id: 'r1',
      item: {
        type: 'reasoning',
        id: 'r1',
        text: [
          { type: 'summary_text', text: 'part one ' },
          { type: 'summary_text', text: 'part two' }
        ]
      }
    })
    expect(parseCodexJsonlLine(legacy)).toEqual([
      { type: 'reasoning.delta', turnId: CODEX_FALLBACK_TURN_ID, text: 'part one part two' }
    ])

    const raw = JSON.stringify({
      type: 'item.completed',
      id: 'r2',
      item: { type: 'reasoning', id: 'r2', raw_content: 'raw thoughts' }
    })
    expect(parseCodexJsonlLine(raw)).toEqual([
      { type: 'reasoning.delta', turnId: CODEX_FALLBACK_TURN_ID, text: 'raw thoughts' }
    ])
  })

  it('synthesizes a turn boundary for a stream that opens with turn.started', () => {
    const parser = createCodexParser(CODEX_FALLBACK_TURN_ID)
    expect(parser.parse('{"type":"turn.started","timestamp":"2026-11-04T09:14:02.121Z"}')).toEqual([
      { type: 'turn.started', turnId: CODEX_FALLBACK_TURN_ID, at: Date.parse('2026-11-04T09:14:02.121Z') }
    ])
    expect(parser.threadId()).toBeUndefined()
  })

  it('never emits two turn.started events for one thread', () => {
    const parser = createCodexParser()
    const started = parser.parse(`{"type":"thread.started","thread_id":"${THREAD}"}`)
    const duplicate = parser.parse('{"type":"turn.started"}')
    expect(started).toHaveLength(1)
    expect(duplicate).toEqual([])
  })
})

describe('codex web_search items', () => {
  it('keeps the whole item as args so the transcript row can show the query', () => {
    const parser = createCodexParser(THREAD)
    const events = parser.parse(
      JSON.stringify({
        timestamp: '2026-11-08T10:00:00.000Z',
        type: 'item.started',
        id: 'item_9',
        item: { type: 'web_search', id: 'item_9', action: { type: 'search', query: 'vitest coverage flags' } }
      })
    )
    expect(events[0]).toMatchObject({
      type: 'tool.call',
      name: 'web_search',
      args: { action: { type: 'search', query: 'vitest coverage flags' } }
    })
  })
})
