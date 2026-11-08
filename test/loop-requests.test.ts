import { describe, expect, it } from 'vitest'
import type { SessionOpts } from '../src/shared/models'
import { buildOpenAiRequest } from '../src/main/agents/loop/openai-compat'
import { buildGeminiRequest } from '../src/main/agents/loop/gemini'

const opts: SessionOpts = {
  workspaceId: 'w1',
  worktreePath: '/tmp/wt',
  model: 'qwen3-max',
  effort: 'medium',
  systemPromptAppend: ''
}

describe('loop request bodies carry native web search', () => {
  it('qwen requests enable search', () => {
    const body = JSON.parse(buildOpenAiRequest(opts, 'key', []).init.body) as Record<string, unknown>
    expect(body.enable_search).toBe(true)
  })

  it('gemini requests include the google_search grounding tool', () => {
    const body = JSON.parse(buildGeminiRequest(opts, 'key', [], 'sys').init.body) as {
      tools: Array<Record<string, unknown>>
    }
    expect(body.tools).toContainEqual({ google_search: {} })
  })
})
