import { describe, expect, it } from 'vitest'
import { parseCodexNotification } from '../src/main/agents/cli/codex-notifications'
import { deriveBlocks } from '../src/shared/blocks'
import { agentEvent } from '../src/shared/events'

const parse = (method: string, payload: Record<string, unknown>) =>
  parseCodexNotification({ method, params: { threadId: 'thread', turnId: 'turn', ...payload } }, 'thread')
const item = (method: string, value: Record<string, unknown>) =>
  parse(method, { item: { id: 'call', ...value } })

describe('Codex app-server work and usage', () => {
  it.each([
    [0, 'completed', true],
    [2, 'completed', false],
    [null, 'declined', false]
  ])('preserves command results (exit: %s, status: %s)', (exitCode, status, ok) => {
    const command = { type: 'commandExecution', command: 'pwd', cwd: '/worktree' }
    const blocks = deriveBlocks([
      ...item('item/started', { ...command, status: 'inProgress' }),
      ...item('item/completed', { ...command, status, exitCode, aggregatedOutput: 'command output' })
    ])
    expect(blocks).toMatchObject([
      { kind: 'tool', name: 'bash', args: { command: 'pwd', cwd: '/worktree' }, ok, output: 'command output' }
    ])
  })

  it.each([
    ['add', 'create'],
    ['update', 'modify'],
    ['delete', 'delete']
  ])('preserves %s file diffs', (type, kind) => {
    expect(
      item('item/completed', {
        type: 'fileChange',
        status: 'completed',
        changes: [{ path: 'notes.txt', kind: { type }, diff: 'file diff' }]
      })
    ).toMatchObject([
      { type: 'tool.result', ok: true, patches: [{ path: 'notes.txt', kind, diff: 'file diff' }] }
    ])
  })

  it('keeps MCP tools distinct from built-ins and retains their reported failure', () => {
    const tool = { type: 'mcpToolCall', server: 'remote', tool: 'bash', arguments: { query: 'docs' } }
    expect(item('item/started', tool)).toMatchObject([
      { type: 'tool.call', name: 'remote/bash', args: { query: 'docs' } }
    ])
    expect(
      item('item/completed', { ...tool, status: 'failed', error: { message: 'Unavailable' } })
    ).toMatchObject([{ type: 'tool.result', ok: false, output: 'Unavailable' }])
  })

  it.each(['webSearch', 'futureTool'])('retains %s calls instead of dropping unknown work', (type) => {
    expect(item('item/started', { type, query: 'docs' })).toMatchObject([
      { type: 'tool.call', name: type === 'webSearch' ? 'web_search' : type, args: { query: 'docs' } }
    ])
  })

  it.each([
    { summary: ['Summary'], text: 'Summary' },
    { summary: [], text: 'Raw reasoning' }
  ])('renders completed reasoning once, preferring its summary', ({ summary, text }) => {
    const reasoning = { type: 'reasoning', summary, content: ['Raw reasoning'] }
    expect(item('item/started', reasoning)).toEqual([])
    expect(item('item/completed', reasoning)).toEqual([{ type: 'reasoning.delta', turnId: 'turn', text }])
  })

  it.each([
    [{ content: [{ type: 'text', text: 'Found docs' }] }, 'Found docs'],
    [{ content: [], structuredContent: { found: 2 } }, '{"found":2}']
  ])('retains readable MCP results', (result, output) => {
    expect(item('item/completed', { type: 'mcpToolCall', status: 'completed', result })).toMatchObject([
      { type: 'tool.result', ok: true, output }
    ])
  })

  it('persists cumulative token/cache totals separately from the last request', () => {
    const [event] = parse('thread/tokenUsage/updated', {
      tokenUsage: {
        total: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800, cacheWriteInputTokens: 20 },
        last: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 40 }
      }
    })
    expect(agentEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual({
      type: 'usage',
      turnId: 'turn',
      inputTokens: 1000,
      outputTokens: 100,
      scope: 'thread',
      cacheReadInputTokens: 800,
      cacheWriteInputTokens: 20
    })
  })

  it.each([undefined, 0])('keeps unknown cache counts distinct from zero (%s)', (cachedInputTokens) => {
    const [event] = parse('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 10, outputTokens: 2, cachedInputTokens } }
    })
    expect(event).toMatchObject({ type: 'usage', cacheReadInputTokens: cachedInputTokens })
    expect(parse('thread/tokenUsage/updated', { tokenUsage: { total: {} } })).toEqual([])
  })
})
