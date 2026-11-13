import { describe, expect, it, vi } from 'vitest'
import { createLoopBackend } from '../src/main/agents/loop/runner'
import { usageByTurn } from '../src/shared/usage'
import type { AgentEvent } from '../src/shared/events'

describe('provider loop guidance and usage', () => {
  it.each(['qwen', 'gemini'] as const)(
    'keeps %s guidance in the active turn and counts usage snapshots once',
    async (backend) => {
      let release!: () => void
      let released = false
      const frame = (text: string, input: number, output: number, cached: number) =>
        backend === 'qwen'
          ? {
              choices: [{ delta: { content: text }, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: input,
                completion_tokens: output,
                prompt_tokens_details: { cached_tokens: cached }
              }
            }
          : {
              candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
              usageMetadata: {
                promptTokenCount: input,
                candidatesTokenCount: output,
                cachedContentTokenCount: cached
              }
            }
      const body = (...frames: unknown[]) =>
        frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  release = () => {
                    if (released) return
                    released = true
                    controller.enqueue(
                      new TextEncoder().encode(body(frame('one', 10, 2, 1), frame('', 20, 4, 5)))
                    )
                    controller.close()
                  }
                }
              })
            )
        )
        .mockResolvedValueOnce(new Response(body(frame('two', 3, 1, 2))))
      const session = await createLoopBackend(backend, {
        getKey: async () => 'test-key',
        fetchImpl
      }).startSession({
        workspaceId: 'w',
        worktreePath: '/tmp',
        model: backend === 'qwen' ? 'qwen3-max' : 'gemini-2.5-pro',
        effort: 'medium',
        systemPromptAppend: ''
      })
      const events: AgentEvent[] = []
      const collecting = (async () => {
        for await (const event of session.events) events.push(event)
      })()
      const sending = session.send('work')
      try {
        await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
        await session.steer!('guidance', [], 'guidance-1')
        release()
        await sending
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect(String(fetchImpl.mock.calls[1]?.[1]?.body)).toContain('guidance')
        expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1)
        expect(events.find((event) => event.type === 'user.steer')).toMatchObject({ messageId: 'guidance-1' })
        expect([...usageByTurn(events).values()]).toMatchObject([
          { inputTokens: 23, outputTokens: 5, cacheReadInputTokens: 7, contextTokens: 3 }
        ])
        await expect(session.steer!('too late')).rejects.toThrow()
      } finally {
        release?.()
        await session.close()
        await collecting
      }
    }
  )
})
