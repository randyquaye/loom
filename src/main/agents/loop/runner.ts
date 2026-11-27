import { randomUUID } from 'node:crypto'
import type { AuthStatus, ModelDescriptor, PromptImage, SessionOpts } from '../../../shared/models'
import type { AgentBackend, NormalizedTool, RunningSession } from '../types'
import {
  buildGeminiRequest,
  GeminiStreamParser,
  GEMINI_BASE_URL,
  GEMINI_MODELS,
  streamGemini
} from './gemini'
import {
  buildOpenAiRequest,
  OpenAiStreamParser,
  QWEN_BASE_URL,
  QWEN_MODELS,
  streamOpenAi
} from './openai-compat'
import { cleanTitle, titleInstruction } from '../../sessions/title'
import { toolRunners, type ToolCtx } from './tools'
import { createEventQueue } from '../queue'
import { addUsageCounts, type UsageCounts } from '../../../shared/usage'

const MAX_TURNS = 25
const TITLE_TIMEOUT_MS = 8000

function qwenTitleText(body: Record<string, unknown>): string | null {
  const choices = body.choices
  if (!Array.isArray(choices)) return null
  const message = (choices[0] as Record<string, unknown> | undefined)?.message as
    Record<string, unknown> | undefined
  return typeof message?.content === 'string' ? message.content : null
}

function geminiTitleText(body: Record<string, unknown>): string | null {
  const candidates = body.candidates
  if (!Array.isArray(candidates)) return null
  const content = (candidates[0] as Record<string, unknown> | undefined)?.content as
    Record<string, unknown> | undefined
  const parts = content?.parts
  if (!Array.isArray(parts)) return null
  const first = parts[0] as Record<string, unknown> | undefined
  return typeof first?.text === 'string' ? first.text : null
}

/**
 * One small non-streaming completion names the session. A title must never cost a tool
 * loop or a long wait, so it is capped in tokens and in time and fails to null.
 */
async function loopTitle(
  backend: LoopBackendId,
  deps: LoopDeps,
  fetchImpl: typeof fetch,
  prompt: string,
  model: string
): Promise<string | null> {
  const key = await deps.getKey()
  if (key === null) return null
  const instruction = titleInstruction(prompt)
  const request =
    backend === 'qwen'
      ? {
          url: `${QWEN_BASE_URL}/chat/completions`,
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: instruction }],
              max_tokens: 16
            })
          }
        }
      : {
          url: `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
          init: {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              contents: [{ parts: [{ text: instruction }] }],
              generationConfig: { maxOutputTokens: 16 }
            })
          }
        }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
  try {
    const res = await fetchImpl(request.url, { ...request.init, signal: controller.signal })
    if (!res.ok) return null
    const body = (await res.json()) as Record<string, unknown>
    return cleanTitle(backend === 'qwen' ? qwenTitleText(body) : geminiTitleText(body))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

type LoopBackendId = 'gemini' | 'qwen'

function appendUser(
  history: unknown[],
  backend: LoopBackendId,
  text: string,
  images: PromptImage[] = []
): void {
  if (backend === 'qwen')
    history.push({
      role: 'user',
      content:
        images.length === 0
          ? text
          : [
              { type: 'text', text },
              ...images.map((image) => ({
                type: 'image_url',
                image_url: { url: `data:${image.mimeType};base64,${image.data}` }
              }))
            ]
    })
  else
    history.push({
      role: 'user',
      parts: [
        { text },
        ...images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } }))
      ]
    })
}

function appendQwenAssistant(history: unknown[], text: string, tools: NormalizedTool[]): void {
  history.push({
    role: 'assistant',
    content: text,
    tool_calls: tools.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args) }
    }))
  })
}

function appendToolResult(
  history: unknown[],
  backend: LoopBackendId,
  tc: NormalizedTool,
  output: string
): void {
  if (backend === 'qwen') history.push({ role: 'tool', tool_call_id: tc.id, content: output })
  else
    history.push({
      role: 'user',
      parts: [
        {
          functionResponse: {
            ...(tc.providerCallId === undefined ? {} : { id: tc.providerCallId }),
            name: tc.name,
            response: { output }
          }
        }
      ]
    })
}

export interface LoopDeps {
  getKey(): Promise<string | null>
  fetchImpl?: typeof fetch
}

export function createLoopBackend(backend: LoopBackendId, deps: LoopDeps): AgentBackend {
  const fetchImpl = deps.fetchImpl ?? fetch

  return {
    id: backend,
    kind: 'loop',
    async authStatus(): Promise<AuthStatus> {
      const key = await deps.getKey()
      return key === null
        ? { state: 'needs-key', hint: `Add a ${backend} API key in Settings` }
        : { state: 'ready' }
    },
    async listModels(): Promise<ModelDescriptor[]> {
      return (backend === 'qwen' ? QWEN_MODELS : GEMINI_MODELS).map((model) => ({
        ...model,
        supportsSteering: true,
        supportsImages: backend === 'gemini'
      }))
    },
    async title(prompt: string, model: string): Promise<string | null> {
      return loopTitle(backend, deps, fetchImpl, prompt, model)
    },
    async startSession(opts: SessionOpts): Promise<RunningSession> {
      const queue = createEventQueue()
      const history: unknown[] = []
      // Loom's instruction prompt is a system message for the own loop (full control),
      // mirroring --append-system-prompt on the CLI backends.
      if (backend === 'qwen') history.push({ role: 'system', content: opts.systemPromptAppend })
      let current: AbortController | null = null
      let cancelled = false
      let closed = false
      let running: Promise<void> | undefined
      let currentTurnId: string | undefined
      const guidance: { text: string; images: PromptImage[] }[] = []

      function flushGuidance(): boolean {
        const pending = guidance.splice(0)
        for (const { text, images } of pending) appendUser(history, backend, text, images)
        return pending.length > 0
      }

      async function runTurn(userText: string, images: PromptImage[]): Promise<void> {
        const turnId = randomUUID()
        currentTurnId = turnId
        let usage: UsageCounts = { inputTokens: 0, outputTokens: 0 }
        // Per-turn controller: cancelling one turn must not poison later turns.
        const controller = new AbortController()
        current = controller
        cancelled = false
        const key = await deps.getKey()
        if (key === null) {
          queue.push({
            type: 'error',
            turnId,
            code: 'no-key',
            message: `${backend} API key missing`,
            retryable: false
          })
          queue.push({ type: 'turn.done', turnId, stopReason: 'error' })
          return
        }
        queue.push({ type: 'turn.started', turnId, at: Date.now() })
        appendUser(history, backend, userText, images)

        for (let step = 0; step < MAX_TURNS; step++) {
          if (cancelled) {
            queue.push({ type: 'turn.done', turnId, stopReason: 'cancelled' })
            return
          }
          const parser = backend === 'qwen' ? new OpenAiStreamParser(turnId) : new GeminiStreamParser(turnId)
          const request =
            backend === 'qwen'
              ? buildOpenAiRequest(opts, key, history)
              : buildGeminiRequest(opts, key, history, opts.systemPromptAppend)

          let res: Response
          try {
            res = await fetchImpl(request.url, { ...request.init, signal: controller.signal })
          } catch (error) {
            if (cancelled) {
              queue.push({ type: 'turn.done', turnId, stopReason: 'cancelled' })
            } else {
              queue.push({ type: 'error', turnId, code: 'fetch', message: String(error), retryable: true })
              queue.push({ type: 'turn.done', turnId, stopReason: 'error' })
            }
            return
          }
          if (!res.ok) {
            const body = await res.text().catch(() => '')
            queue.push({
              type: 'error',
              turnId,
              code: `http-${res.status}`,
              message: body.slice(0, 500),
              retryable: res.status >= 500
            })
            queue.push({ type: 'turn.done', turnId, stopReason: 'error' })
            return
          }

          const stream =
            backend === 'qwen'
              ? streamOpenAi(res, parser as OpenAiStreamParser)
              : streamGemini(res, parser as GeminiStreamParser)
          let requestUsage: UsageCounts | undefined
          try {
            for await (const event of stream) {
              if (event.type === 'usage') {
                requestUsage = {
                  ...event,
                  cacheReadInputTokens: event.cacheReadInputTokens ?? requestUsage?.cacheReadInputTokens,
                  cacheWriteInputTokens: event.cacheWriteInputTokens ?? requestUsage?.cacheWriteInputTokens
                }
                queue.push({
                  ...event,
                  ...addUsageCounts(usage, requestUsage),
                  scope: 'turn',
                  contextTokens: requestUsage.inputTokens
                })
              } else queue.push(event)
            }
          } catch (error) {
            // A stream that throws mid-iteration must still close its turn, or
            // the renderer waits forever for a terminal event.
            if (cancelled) {
              queue.push({ type: 'turn.done', turnId, stopReason: 'cancelled' })
            } else {
              queue.push({ type: 'error', turnId, code: 'stream', message: String(error), retryable: false })
              queue.push({ type: 'turn.done', turnId, stopReason: 'error' })
            }
            return
          }
          if (requestUsage !== undefined) usage = addUsageCounts(usage, requestUsage)

          const accumulated = parser.accumulatedText()
          if (accumulated !== '') queue.push({ type: 'text.done', turnId, text: accumulated })

          const tools: NormalizedTool[] =
            backend === 'qwen'
              ? (parser as OpenAiStreamParser).pendingTools()
              : (parser as GeminiStreamParser).pendingTools()

          if (parser instanceof GeminiStreamParser) history.push(parser.assistantContent())
          else appendQwenAssistant(history, parser.accumulatedText(), tools)
          const ctx: ToolCtx = { worktreePath: opts.worktreePath, signal: controller.signal, env: opts.env }
          for (const tc of tools) {
            if (cancelled) break
            let result
            try {
              result = await toolRunners[tc.name](tc.args, ctx)
            } catch (error) {
              result = { ok: false, output: String(error) }
            }
            queue.push({ type: 'tool.result', turnId, callId: tc.id, ok: result.ok, output: result.output })
            appendToolResult(history, backend, tc, result.output)
          }
          const guided = flushGuidance()
          if (tools.length === 0 && !guided) {
            queue.push({ type: 'turn.done', turnId, stopReason: cancelled ? 'cancelled' : 'end' })
            return
          }
        }
        queue.push({ type: 'turn.done', turnId, stopReason: 'limit' })
      }

      return {
        async send(text: string, images: PromptImage[] = []): Promise<void> {
          if (closed || running !== undefined)
            throw new Error('Session is closed or a turn is already running')
          const work = runTurn(text, images).finally(() => {
            flushGuidance()
            current = null
            currentTurnId = undefined
          })
          running = work
          try {
            await work
          } finally {
            if (running === work) running = undefined
          }
        },
        async steer(text: string, images: PromptImage[] = [], messageId?: string): Promise<void> {
          if (closed || currentTurnId === undefined || cancelled)
            throw new Error('There is no active turn to steer')
          guidance.push({ text, images })
          queue.push({
            type: 'user.steer',
            turnId: currentTurnId,
            text,
            ...(messageId === undefined ? {} : { messageId })
          })
        },
        async cancel(): Promise<void> {
          cancelled = true
          current?.abort()
          await running
        },
        async close(): Promise<void> {
          closed = true
          cancelled = true
          current?.abort()
          await running
          queue.end()
        },
        providerSessionId: () => undefined,
        events: queue.iterable
      }
    }
  }
}
