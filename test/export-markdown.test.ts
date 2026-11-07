import { describe, expect, it } from 'vitest'
import { eventsToMarkdown } from '../src/main/export/markdown'
import type { AgentEvent } from '../src/shared/events'

const meta = {
  title: 'rate limit work',
  backend: 'qwen',
  model: 'qwen3-max',
  effort: 'medium',
  createdAt: 1767225600000
}

const events: AgentEvent[] = [
  { type: 'turn.started', turnId: 't1', at: 1 },
  { type: 'text.delta', turnId: 't1', text: 'hello ' },
  { type: 'text.delta', turnId: 't1', text: 'world' },
  { type: 'tool.call', turnId: 't1', callId: 'c1', name: 'bash', args: { cmd: 'ls' } },
  { type: 'tool.result', turnId: 't1', callId: 'c1', ok: true, output: 'a.ts' },
  { type: 'turn.done', turnId: 't1', stopReason: 'end' }
]

describe('eventsToMarkdown', () => {
  it('renders title, metadata and merged text', () => {
    const md = eventsToMarkdown(meta, events)
    expect(md).toContain('# rate limit work')
    expect(md).toContain('qwen · qwen3-max · medium')
    expect(md).toContain('hello world')
  })

  it('renders tool blocks with args and output', () => {
    const md = eventsToMarkdown(meta, events)
    expect(md).toContain('<summary>bash</summary>')
    expect(md).toContain('"cmd": "ls"')
    expect(md).toContain('a.ts')
  })

  it('marks failed tools', () => {
    const md = eventsToMarkdown(meta, [
      { type: 'tool.call', turnId: 't', callId: 'c', name: 'grep', args: {} },
      { type: 'tool.result', turnId: 't', callId: 'c', ok: false, output: 'boom' }
    ])
    expect(md).toContain('<summary>grep ✗</summary>')
  })
})
