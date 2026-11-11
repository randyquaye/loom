import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_FALLBACK_TURN_ID,
  createClaudeParser,
  parseClaudeStreamLine
} from '../src/main/agents/cli/parse-claude'
import { agentEvent, type AgentEvent } from '../src/shared/events'

const FIXTURE = fileURLToPath(new URL('./fixtures/claude-stream-sample.jsonl', import.meta.url))
const SESSION = '7f3c1d92-4b6a-4e0f-9c31-5a8d2e6b0f14'
const WORKTREE = '/Users/randyquaye/Library/Application Support/Loom/workspaces/loom/p3-cli'

function fixtureLines(): string[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
}

function replay(lines: string[]): AgentEvent[] {
  const parser = createClaudeParser(SESSION)
  return lines.flatMap((line) => parser.parse(line))
}

describe('claude fixture replay', () => {
  const events = replay(fixtureLines())

  it('has at least ten records to replay', () => {
    expect(fixtureLines().length).toBeGreaterThanOrEqual(10)
  })

  it('produces the exact normalized event sequence', () => {
    expect(events).toEqual([
      { type: 'turn.started', turnId: SESSION, at: 0 },
      {
        type: 'reasoning.delta',
        turnId: SESSION,
        text: 'Listing the adapter directory first is cheaper than reading every file.'
      },
      {
        type: 'text.delta',
        turnId: SESSION,
        text: "I'll list the adapter modules, then read the line buffer."
      },
      {
        type: 'text.done',
        turnId: SESSION,
        text: "I'll list the adapter modules, then read the line buffer."
      },
      {
        type: 'tool.call',
        turnId: SESSION,
        callId: 'toolu_01Ls',
        name: 'bash',
        args: { command: 'ls -1 src/main/agents/cli', description: 'List the CLI adapter modules' }
      },
      {
        type: 'tool.result',
        turnId: SESSION,
        callId: 'toolu_01Ls',
        ok: true,
        output: 'args.ts\ncatalog.ts\nparse-codex.ts\nparse-claude.ts\nspawn.ts\n'
      },
      {
        type: 'tool.call',
        turnId: SESSION,
        callId: 'toolu_02Rd',
        name: 'read_file',
        args: { file_path: `${WORKTREE}/src/main/agents/cli/spawn.ts`, limit: 4 }
      },
      {
        type: 'tool.result',
        turnId: SESSION,
        callId: 'toolu_02Rd',
        ok: true,
        output:
          "import { spawn, type ChildProcess } from 'node:child_process'\n" +
          "import type { AgentEvent } from '../../../shared/events'\n"
      },
      // WebFetch has no built-in mapping, so it renders as a generic row under its raw
      // name; the tool_result still arrives and keeps the failure text searchable.
      {
        type: 'tool.call',
        turnId: SESSION,
        callId: 'toolu_03Wf',
        name: 'WebFetch',
        args: { url: 'https://example.invalid/stream', prompt: 'summarize' }
      },
      {
        type: 'tool.result',
        turnId: SESSION,
        callId: 'toolu_03Wf',
        ok: false,
        output: 'fetch blocked: no network in this session'
      },
      {
        type: 'text.delta',
        turnId: SESSION,
        text: 'All five modules are present; the line buffer is src/main/agents/cli/spawn.ts:88.'
      },
      {
        type: 'text.done',
        turnId: SESSION,
        text: 'All five modules are present; the line buffer is src/main/agents/cli/spawn.ts:88.'
      },
      {
        type: 'usage',
        turnId: SESSION,
        scope: 'turn',
        inputTokens: 6260,
        outputTokens: 642,
        cacheReadInputTokens: 1024,
        cacheWriteInputTokens: 2048
      },
      { type: 'turn.done', turnId: SESSION, stopReason: 'end' }
    ])
  })

  it('emits only events the shared schema accepts', () => {
    for (const event of events) {
      expect(agentEvent.safeParse(event).success, JSON.stringify(event)).toBe(true)
    }
  })

  it('ignores stream_event, hook and compact_boundary records', () => {
    const ignored = events.filter((e) => e.type === 'turn.started')
    expect(ignored).toHaveLength(1)
  })

  it('captures the session id so a later turn can resume it', () => {
    const parser = createClaudeParser()
    for (const line of fixtureLines()) parser.parse(line)
    expect(parser.sessionId()).toBe(SESSION)
  })

  it('includes subagent usage from the captured per-result model totals', () => {
    const capture = readFileSync(new URL('./fixtures/claude-subagent-capture.jsonl', import.meta.url), 'utf8')
    const events = replay(capture.trim().split('\n'))
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      scope: 'turn',
      inputTokens: 74250,
      outputTokens: 174,
      cacheReadInputTokens: 35428,
      cacheWriteInputTokens: 38816
    })
  })

  it('sums per-result models without counting cumulative model totals again', () => {
    const counts = { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 5, cacheCreationInputTokens: 7 }
    const events = parseClaudeStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: { earlier: { ...counts, inputTokens: 99999 } },
        model_usage_since_last_result: {
          main: counts,
          subagent: { ...counts, inputTokens: 11 }
        }
      })
    )
    expect(events.find((event) => event.type === 'usage')).toMatchObject({
      inputTokens: 37,
      outputTokens: 6,
      cacheReadInputTokens: 10,
      cacheWriteInputTokens: 14
    })
  })
})

describe('parseClaudeStreamLine tolerance', () => {
  it('ignores blank lines', () => {
    expect(parseClaudeStreamLine('')).toEqual([])
    expect(parseClaudeStreamLine('\n')).toEqual([])
  })

  it('turns malformed JSON into exactly one error event instead of throwing', () => {
    const events = parseClaudeStreamLine('{"type":"assistant", "message":')
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      type: 'error',
      turnId: CLAUDE_FALLBACK_TURN_ID,
      code: 'claude.malformed-json',
      message: expect.stringContaining('unparseable claude stream-json line'),
      retryable: false
    })
  })

  it('ignores valid JSON that is not an object', () => {
    for (const line of ['7', '"text"', '[{"type":"assistant"}]', 'null']) {
      expect(parseClaudeStreamLine(line), line).toEqual([])
    }
  })

  it('ignores unknown record types and non-init system records', () => {
    expect(parseClaudeStreamLine('{"type":"control_request","request_id":"1"}')).toEqual([])
    expect(parseClaudeStreamLine('{"type":"control_response","response":{}}')).toEqual([])
    expect(parseClaudeStreamLine('{"type":"brand.new.record","x":1}')).toEqual([])
    expect(
      parseClaudeStreamLine(`{"type":"system","subtype":"compact_boundary","session_id":"${SESSION}"}`)
    ).toEqual([])
  })

  it('maps every claude tool name Loom has vocabulary for', () => {
    const pairs: Array<[string, string]> = [
      ['Bash', 'bash'],
      ['Read', 'read_file'],
      ['Write', 'write_file'],
      ['Edit', 'edit_file'],
      ['MultiEdit', 'edit_file'],
      ['NotebookEdit', 'edit_file'],
      ['Glob', 'glob'],
      ['Grep', 'grep']
    ]
    for (const [claudeName, toolName] of pairs) {
      const line = JSON.stringify({
        type: 'assistant',
        session_id: SESSION,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t-${claudeName}`, name: claudeName, input: { a: 1 } }]
        }
      })
      expect(parseClaudeStreamLine(line, SESSION), claudeName).toEqual([
        { type: 'tool.call', turnId: SESSION, callId: `t-${claudeName}`, name: toolName, args: { a: 1 } }
      ])
    }
  })

  it('renders unmapped tool_use blocks as generic rows under their raw name', () => {
    for (const name of ['WebFetch', 'TodoWrite', 'mcp__github__list_prs']) {
      const line = JSON.stringify({
        type: 'assistant',
        session_id: SESSION,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name, input: {} }] }
      })
      expect(parseClaudeStreamLine(line), name).toEqual([
        { type: 'tool.call', turnId: CLAUDE_FALLBACK_TURN_ID, callId: 'x', name, args: {} }
      ])
    }
  })

  it('maps the subagent spawn tool to a subagent row, not a tool row', () => {
    for (const name of ['Agent', 'Task']) {
      const line = JSON.stringify({
        type: 'assistant',
        session_id: SESSION,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'x',
              name,
              input: { description: 'count files', prompt: 'count them' }
            }
          ]
        }
      })
      expect(parseClaudeStreamLine(line), name).toEqual([
        {
          type: 'subagent.start',
          turnId: CLAUDE_FALLBACK_TURN_ID,
          callId: 'x',
          description: 'count files',
          prompt: 'count them'
        }
      ])
    }
  })

  it('keeps text.done adjacent to the deltas that built it', () => {
    const trailingTool = JSON.stringify({
      type: 'assistant',
      session_id: SESSION,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first ' },
          { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'true' } }
        ]
      }
    })
    expect(parseClaudeStreamLine(trailingTool).map((e) => e.type)).toEqual([
      'text.delta',
      'text.done',
      'tool.call'
    ])

    const trailingText = JSON.stringify({
      type: 'assistant',
      session_id: SESSION,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first ' },
          { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'true' } },
          { type: 'text', text: 'second' }
        ]
      }
    })
    const events = parseClaudeStreamLine(trailingText)
    expect(events.map((e) => e.type)).toEqual(['text.delta', 'tool.call', 'text.delta', 'text.done'])
    expect(events.find((e) => e.type === 'text.done')).toMatchObject({ text: 'first second' })
  })

  it('reads tool_result content from both the string and block-array forms', () => {
    const asString = JSON.stringify({
      type: 'user',
      session_id: SESSION,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'a', content: 'plain', is_error: false }]
      }
    })
    expect(parseClaudeStreamLine(asString, SESSION)).toEqual([
      { type: 'tool.result', turnId: SESSION, callId: 'a', ok: true, output: 'plain' }
    ])

    const asBlocks = JSON.stringify({
      type: 'user',
      session_id: SESSION,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'b',
            content: [
              { type: 'text', text: 'one ' },
              { type: 'text', text: 'two' }
            ]
          }
        ]
      }
    })
    expect(parseClaudeStreamLine(asBlocks, SESSION)).toEqual([
      { type: 'tool.result', turnId: SESSION, callId: 'b', ok: true, output: 'one two' }
    ])
  })

  it('maps result subtypes onto stop reasons', () => {
    const success = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: SESSION,
      usage: { input_tokens: 10, output_tokens: 4 }
    })
    expect(parseClaudeStreamLine(success, SESSION)).toEqual([
      { type: 'usage', turnId: SESSION, scope: 'turn', inputTokens: 10, outputTokens: 4 },
      { type: 'turn.done', turnId: SESSION, stopReason: 'end' }
    ])

    const maxTurns = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      session_id: SESSION,
      usage: {}
    })
    expect(parseClaudeStreamLine(maxTurns, SESSION)).toEqual([
      {
        type: 'error',
        turnId: SESSION,
        code: 'claude.error_max_turns',
        message: expect.stringContaining('error_max_turns'),
        retryable: false
      },
      { type: 'turn.done', turnId: SESSION, stopReason: 'limit' }
    ])

    const duringExecution = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: SESSION,
      result: 'API connection failed'
    })
    expect(parseClaudeStreamLine(duringExecution, SESSION)).toEqual([
      {
        type: 'error',
        turnId: SESSION,
        code: 'claude.error_during_execution',
        message: 'API connection failed',
        retryable: false
      },
      { type: 'turn.done', turnId: SESSION, stopReason: 'error' }
    ])
  })

  it('treats an error result under a success subtype as an error', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      session_id: SESSION,
      result: 'boom'
    })
    const events = parseClaudeStreamLine(line)
    expect(events.map((e) => e.type)).toEqual(['error', 'turn.done'])
    expect(events[1]).toMatchObject({ stopReason: 'error' })
  })

  it('uses the fallback turn id when the record carries no session id', () => {
    expect(parseClaudeStreamLine('{"type":"system","subtype":"init"}')).toEqual([
      { type: 'turn.started', turnId: CLAUDE_FALLBACK_TURN_ID, at: 0 }
    ])
  })
})
