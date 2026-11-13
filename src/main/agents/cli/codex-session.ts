import { randomUUID } from 'node:crypto'
import type { PromptImage, SessionOpts } from '../../../shared/models'
import { questionAnswer, questionRequest, type QuestionRequest } from '../../../shared/events'
import { usageFields, type UsageCounts, type UsageEvent } from '../../../shared/usage'
import {
  questionAnswerText,
  validateQuestionAnswers,
  visibleQuestionAnswers
} from '../../../shared/questions'
import type { WorkspaceRuntime } from '../../runtime'
import type { RunningSession } from '../types'
import { createEventQueue } from '../queue'
import { assertSessionOpts } from './args'
import { openCodexThread } from './codex-app-server'
import { codexApprovalQuestion } from './codex-approvals'
import { parseCodexNotification } from './codex-notifications'
import { errorEvent, isRec, num, str, sub } from './record'
import type { RpcCall, RpcId } from './rpc'

export type RequestHandler = (call: RpcCall, reply: (result: unknown) => Promise<void>) => void
interface Turn {
  id: string
  startSettled: Promise<void>
  startup: AbortController | undefined
  done: Promise<void>
  finish(): void
  usageBase?: Partial<UsageCounts>
}

function codexInput(text: string, images: PromptImage[]) {
  return [
    { type: 'text', text },
    ...images.map((image) => ({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` }))
  ]
}

export function startCodexSession(
  opts: SessionOpts,
  onRequest?: RequestHandler,
  runtime?: WorkspaceRuntime
): RunningSession {
  assertSessionOpts('codex', opts)
  const queue = createEventQueue()
  let active: Turn | undefined
  let closed = false
  let threadId = opts.resumeId ?? ''
  let connection: Awaited<ReturnType<typeof openCodexThread>> | undefined
  let steering = Promise.resolve()
  let threadUsage: UsageCounts | undefined

  function turnUsage(event: UsageEvent, call: RpcCall): UsageEvent | undefined {
    const previous = threadUsage
    threadUsage = event
    const current = active
    if (current === undefined || current.id !== event.turnId) return
    const last = isRec(call.params) ? (sub(sub(call.params, 'tokenUsage') ?? {}, 'last') ?? {}) : {}
    if (current.usageBase === undefined) {
      current.usageBase = {}
      for (const field of usageFields) {
        const lastValue = num(last, field === 'cacheReadInputTokens' ? 'cachedInputTokens' : field)
        const value = event[field]
        const baseline =
          previous?.[field] ??
          (value !== undefined && lastValue !== undefined
            ? value - lastValue
            : opts.resumeId === undefined
              ? 0
              : undefined)
        if (baseline !== undefined) current.usageBase[field] = baseline
      }
    }
    const delta = (field: (typeof usageFields)[number]): number | undefined => {
      const value = event[field]
      const baseline = current.usageBase?.[field]
      return value === undefined || baseline === undefined ? undefined : Math.max(0, value - baseline)
    }
    const inputTokens = delta('inputTokens')
    const outputTokens = delta('outputTokens')
    const contextTokens = num(last, 'inputTokens') || num(last, 'totalTokens')
    if (inputTokens === undefined || outputTokens === undefined) return { ...event, contextTokens }
    return {
      ...event,
      scope: 'turn',
      inputTokens,
      outputTokens,
      contextTokens,
      cacheReadInputTokens: delta('cacheReadInputTokens'),
      cacheWriteInputTokens: delta('cacheWriteInputTokens')
    }
  }

  function steer(
    text: string,
    images: PromptImage[] = [],
    receipt = text,
    messageId?: string
  ): Promise<void> {
    const current = active
    if (current === undefined || closed) return Promise.reject(new Error('There is no active turn to steer'))
    const work = steering
      .catch(() => undefined)
      .then(async () => {
        await Promise.race([current.startSettled, current.done])
        if (closed || active !== current || connection === undefined)
          throw new Error('The turn ended before guidance was delivered')
        await connection.rpc.request('turn/steer', {
          threadId,
          expectedTurnId: current.id,
          input: codexInput(text, images)
        })
        queue.push({
          type: 'user.steer',
          turnId: current.id,
          text: receipt,
          ...(messageId === undefined ? {} : { messageId })
        })
      })
    steering = work
    return work
  }
  const questions = new Map<
    string,
    {
      event: QuestionRequest
      providerId: RpcId
      reply: Parameters<RequestHandler>[1]
      sending: boolean
    }
  >()

  function addQuestion(
    event: QuestionRequest,
    providerId: RpcId,
    reply: Parameters<RequestHandler>[1]
  ): void {
    questions.set(event.requestId, { event, providerId, reply, sending: false })
    queue.push(event)
  }

  function resolveQuestion(requestId: string): void {
    const pending = questions.get(requestId)
    if (pending === undefined) return
    questions.delete(requestId)
    queue.push({ type: 'question.resolved', requestId, turnId: pending.event.turnId })
  }

  function clearQuestions(blockingOnly = false): void {
    for (const [requestId, pending] of questions)
      if (!blockingOnly || pending.event.blocking) resolveQuestion(requestId)
  }

  function finishActiveTurn(reason: 'error' | 'cancelled', error: unknown): void {
    const current = active
    if (current === undefined) return
    active = undefined
    clearQuestions()
    if (reason === 'error') queue.push(errorEvent(current.id, 'codex.connection', String(error), false))
    queue.push({ type: 'turn.done', turnId: current.id, stopReason: reason })
    current.finish()
  }

  async function connect(signal: AbortSignal | undefined) {
    const ready = await openCodexThread(
      opts,
      (call, rpc) => {
        const id = call.id
        const params = isRec(call.params) ? call.params : undefined
        if (id !== undefined) {
          const reply = (result: unknown) => rpc.respond(id, result)
          const approval = codexApprovalQuestion(call, threadId, reply)
          if (approval !== undefined) {
            addQuestion(approval.event, id, approval.reply)
            return
          }
          if (call.method === 'item/tool/requestUserInput' && params?.['threadId'] === threadId) {
            const event = questionRequest.safeParse({
              type: 'question.requested',
              requestId: randomUUID(),
              turnId: params['turnId'],
              callId: params['itemId'],
              blocking: params['isBlocking'] ?? true,
              questions: params['questions']
            })
            if (event.success) {
              addQuestion(event.data, id, reply)
              if (!event.data.blocking)
                void reply({ answers: {} }).catch((error: unknown) => finishActiveTurn('error', error))
              return
            }
          }
          if (onRequest !== undefined) return onRequest(call, reply)
          const message = `Unsupported agent request: ${call.method}`
          queue.push(errorEvent(active?.id, 'codex.unsupported-request', message, true))
          void rpc
            .reject(id, -32601, message)
            .catch((error: unknown) => finishActiveTurn(closed ? 'cancelled' : 'error', error))
          return
        }
        if (call.method === 'serverRequest/resolved' && params?.['threadId'] === threadId) {
          for (const [requestId, pending] of questions) {
            if (pending.providerId === params['requestId'] && pending.event.blocking)
              resolveQuestion(requestId)
          }
          return
        }
        for (const event of parseCodexNotification(call, threadId)) {
          if (event.type === 'usage' && event.scope === 'thread') {
            const usage = turnUsage(event, call)
            if (usage !== undefined) queue.push(usage)
            continue
          }
          if (event.type === 'turn.started' && active !== undefined) active.id = event.turnId
          if (event.type === 'turn.done') {
            if (active === undefined || active.id !== event.turnId) continue
            const current = active
            active = undefined
            clearQuestions(true)
            current.finish()
          }
          queue.push(event)
        }
      },
      signal,
      runtime
    )
    if (signal?.aborted) {
      await ready.close()
      signal.throwIfAborted()
    }
    connection = ready
    threadId = ready.threadId
    void ready.rpc.closed.then((error) => {
      const reason = closed ? 'cancelled' : 'error'
      closed = true
      finishActiveTurn(reason, error)
      clearQuestions()
      queue.end()
    })
    return ready
  }

  return {
    events: queue.iterable,
    providerSessionId: () => threadId || undefined,
    steer: (text, images = [], messageId) => steer(text, images, text, messageId),
    async answerQuestion(input) {
      const { requestId, answers } = questionAnswer.parse(input)
      const pending = questions.get(requestId)
      if (pending === undefined || pending.sending)
        throw new Error('Question is no longer awaiting an answer')
      validateQuestionAnswers(pending.event, input)
      const visible = visibleQuestionAnswers(pending.event, answers)
      pending.sending = true
      try {
        if (!pending.event.blocking)
          await steer(
            questionAnswerText(pending.event, answers),
            [],
            questionAnswerText(pending.event, visible)
          )
        else
          await pending.reply({
            answers: Object.fromEntries(
              Object.entries(answers).map(([id, values]) => [id, { answers: values }])
            )
          })
        queue.push({ type: 'question.answered', requestId, turnId: pending.event.turnId, answers: visible })
        resolveQuestion(requestId)
      } finally {
        pending.sending = false
      }
    },
    async send(text, images = []) {
      if (closed) throw new Error('Codex session is closed')
      if (active !== undefined) throw new Error('A Codex turn is already running')
      clearQuestions()
      let finish!: () => void
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })
      const current: Turn = {
        id: randomUUID(),
        startSettled: Promise.resolve(),
        done,
        finish,
        startup: connection === undefined ? new AbortController() : undefined
      }
      active = current
      current.startSettled = (async () => {
        const ready = connection ?? (await connect(current.startup?.signal))
        if (closed || active !== current) return
        const result = await ready.rpc.request('turn/start', {
          threadId,
          input: codexInput(text, images)
        })
        const turn = isRec(result) ? sub(result, 'turn') : undefined
        const id = turn === undefined ? undefined : str(turn, 'id')
        if (!id) throw new Error('Codex returned no turn ID')
        if (active === current) current.id = id
      })().catch((error: unknown) => {
        if (active === current) {
          finishActiveTurn(closed || current.startup?.signal.aborted ? 'cancelled' : 'error', error)
        }
      })
      await current.done
    },
    async cancel() {
      const current = active
      if (current === undefined) return
      const rpc = connection?.rpc
      if (rpc === undefined) {
        current.startup?.abort()
        await current.done
        return
      }
      await Promise.race([current.startSettled, current.done])
      if (active !== current) return
      try {
        await rpc.request('turn/interrupt', { threadId, turnId: current.id })
      } catch (error) {
        if (active === current) throw error
      }
      await current.done
    },
    async close() {
      closed = true
      clearQuestions()
      const current = active
      current?.startup?.abort()
      await connection?.close()
      await current?.done
      queue.end()
    }
  }
}
