import type { AgentEvent, ToolName } from '../../../shared/events'
import type { ModelDescriptor, SessionOpts } from '../../../shared/models'
import type { NormalizedTool } from '../types'
import { bodyChunks, ssePayloads } from './sse'
import { isToolName, TOOL_PARAMETER_SCHEMAS, toolRunners } from './tools'

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export const GEMINI_MODELS: ModelDescriptor[] = [
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  },
  // Flash's thinking budget tops out below pro's; its ladder stops at xhigh.
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    efforts: ['minimal', 'low', 'medium', 'high', 'xhigh']
  }
]

export const GEMINI_TOOL_DECLS = {
  functionDeclarations: (Object.keys(toolRunners) as ToolName[]).map((name) => ({
    name,
    description: `Workspace tool: ${name}`,
    parameters: {
      type: 'OBJECT',
      properties: Object.fromEntries(
        Object.entries(TOOL_PARAMETER_SCHEMAS[name].properties).map(([key, value]) => [
          key,
          { type: value.type.toUpperCase() }
        ])
      ),
      required: TOOL_PARAMETER_SCHEMAS[name].required
    }
  }))
}

function budgetFor(effort: string): number {
  switch (effort) {
    case 'minimal':
      return 0
    case 'low':
      return 1024
    case 'high':
      return 16384
    case 'xhigh':
      return 24576
    case 'max':
    case 'ultra':
      return 32768
    default:
      return 4096
  }
}

/**
 * Gemini's alt=sse stream can deliver a JSON *array* of chunks per data line
 * (leading '[' and comma-joined objects); tolerate both shapes.
 */
export class GeminiStreamParser {
  done = false
  private text = ''
  private toolCalls: NormalizedTool[] = []

  constructor(private readonly turnId: string) {}

  accumulatedText(): string {
    return this.text
  }

  pendingTools(): NormalizedTool[] {
    return this.toolCalls
  }

  *push(payload: string): Generator<AgentEvent> {
    const trimmed = payload.trim()
    if (trimmed === '') return
    let chunks: unknown[]
    try {
      const parsed: unknown = JSON.parse(trimmed)
      chunks = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return
    }
    for (const raw of chunks) {
      const obj = raw as Record<string, unknown>
      const candidates = obj.candidates as Array<Record<string, unknown>> | undefined
      const candidate = candidates?.[0]
      const content = candidate?.content as Record<string, unknown> | undefined
      const parts = (content?.parts ?? []) as Array<Record<string, unknown>>
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text !== '') {
          if (part.thought === true) {
            yield { type: 'reasoning.delta', turnId: this.turnId, text: part.text }
          } else {
            this.text += part.text
            yield { type: 'text.delta', turnId: this.turnId, text: part.text }
          }
        }
        const fc = part.functionCall as Record<string, unknown> | undefined
        if (fc !== undefined && isToolName(fc.name)) {
          const call: NormalizedTool = {
            id: `${fc.name}-${this.toolCalls.length + 1}`,
            name: fc.name,
            args: fc.args ?? {}
          }
          this.toolCalls.push(call)
          yield { type: 'tool.call', turnId: this.turnId, callId: call.id, name: call.name, args: call.args }
        }
      }
      const usage = obj.usageMetadata as Record<string, unknown> | undefined
      if (usage !== undefined) {
        yield {
          type: 'usage',
          turnId: this.turnId,
          inputTokens: (usage.promptTokenCount as number) ?? 0,
          outputTokens: (usage.candidatesTokenCount as number) ?? 0
        }
      }
      const finish = candidate?.finishReason as string | undefined
      if (finish === 'STOP' || finish === 'MAX_TOKENS') this.done = true
    }
  }
}

export function buildGeminiRequest(
  opts: SessionOpts,
  apiKey: string,
  contents: unknown[],
  systemInstruction: string
) {
  return {
    url: `${GEMINI_BASE_URL}/models/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        // Function declarations plus Google Search grounding: the loop vocabulary had no
        // web tool at all, so gemini sessions could not search even when asked.
        tools: [GEMINI_TOOL_DECLS, { google_search: {} }],
        generationConfig: { thinkingConfig: { thinkingBudget: budgetFor(opts.effort) } }
      })
    }
  }
}

export async function* streamGemini(res: Response, parser: GeminiStreamParser): AsyncGenerator<AgentEvent> {
  if (res.body === null) return
  for await (const payload of ssePayloads(bodyChunks(res.body))) {
    yield* parser.push(payload)
    if (parser.done) return
  }
}
