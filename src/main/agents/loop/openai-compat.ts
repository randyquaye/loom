import type { AgentEvent, ToolName } from '../../../shared/events'
import type { ModelDescriptor, SessionOpts } from '../../../shared/models'
import type { NormalizedTool } from '../types'
import { bodyChunks, ssePayloads } from './sse'
import { isToolName, TOOL_PARAMETER_SCHEMAS, toolRunners } from './tools'

export const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

export const QWEN_MODELS: ModelDescriptor[] = [
  { id: 'qwen3-max', label: 'Qwen3 Max', efforts: ['low', 'medium', 'high'] },
  { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', efforts: ['low', 'medium', 'high'] }
]

export const OPENAI_TOOL_DEFS = (Object.keys(toolRunners) as ToolName[]).map((name) => ({
  type: 'function' as const,
  function: {
    name,
    description: `Workspace tool: ${name}`,
    parameters: { type: 'object', ...TOOL_PARAMETER_SCHEMAS[name] }
  }
}))

export function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

interface PendingTool {
  id: string
  name: string
  args: string
}

/** Accumulates streamed text and tool_call fragments for one turn. */
export class OpenAiStreamParser {
  done = false
  private text = ''
  private toolBuf = new Map<number, PendingTool>()
  private emitted: NormalizedTool[] = []

  constructor(private readonly turnId: string) {}

  accumulatedText(): string {
    return this.text
  }

  pendingTools(): NormalizedTool[] {
    // The stream buffer is cleared once calls are emitted; the runner reads
    // this list after the stream ends, so it must see the emitted calls.
    return [...this.emitted]
  }

  *push(payload: string): Generator<AgentEvent> {
    if (payload === '[DONE]') {
      this.done = true
      return
    }
    let json: Record<string, unknown>
    try {
      json = JSON.parse(payload) as Record<string, unknown>
    } catch {
      return
    }
    const choices = json.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    const delta = choice?.delta as Record<string, unknown> | undefined
    if (typeof delta?.content === 'string' && delta.content !== '') {
      this.text += delta.content
      yield { type: 'text.delta', turnId: this.turnId, text: delta.content }
    }
    const toolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const index = typeof tc.index === 'number' ? tc.index : 0
        const existing = this.toolBuf.get(index) ?? { id: '', name: '', args: '' }
        const fn = tc.function as Record<string, unknown> | undefined
        if (typeof tc.id === 'string') existing.id = tc.id
        if (typeof fn?.name === 'string') existing.name = fn.name
        if (typeof fn?.arguments === 'string') existing.args += fn.arguments
        this.toolBuf.set(index, existing)
      }
    }
    if (choice?.finish_reason === 'tool_calls') {
      for (const pending of this.toolBuf.values()) {
        if (!isToolName(pending.name)) continue
        const call: NormalizedTool = {
          id: pending.id || pending.name,
          name: pending.name,
          args: safeJson(pending.args)
        }
        this.emitted.push(call)
        yield { type: 'tool.call', turnId: this.turnId, callId: call.id, name: call.name, args: call.args }
      }
      this.toolBuf.clear()
    }
    const usage = json.usage as Record<string, unknown> | undefined
    if (usage) {
      yield {
        type: 'usage',
        turnId: this.turnId,
        inputTokens: (usage.prompt_tokens as number) ?? 0,
        outputTokens: (usage.completion_tokens as number) ?? 0
      }
    }
  }
}

export function buildOpenAiRequest(opts: SessionOpts, apiKey: string, messages: unknown[]) {
  return {
    url: `${QWEN_BASE_URL}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        messages,
        tools: OPENAI_TOOL_DEFS,
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort: opts.effort
      })
    }
  }
}

export async function* streamOpenAi(res: Response, parser: OpenAiStreamParser): AsyncGenerator<AgentEvent> {
  if (res.body === null) return
  for await (const payload of ssePayloads(bodyChunks(res.body))) {
    yield* parser.push(payload)
    if (parser.done) return
  }
}
