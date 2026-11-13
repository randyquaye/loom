import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import {
  questionRequest,
  type AgentEvent,
  type QuestionAnswer,
  type QuestionRequest
} from '../../../shared/events'
import type { PromptImage, SessionOpts } from '../../../shared/models'
import { validateQuestionAnswers, visibleQuestionAnswers } from '../../../shared/questions'
import { addUsageCounts, type UsageCounts } from '../../../shared/usage'
import { createEventQueue } from '../queue'
import type { RunningSession } from '../types'
import { buildClaudeArgs } from './args'
import { claudeUsage, createClaudeParser } from './parse-claude'
import { errorEvent, list, str, sub, tryParseRecord, type Rec } from './record'
import { machineRuntime, type RuntimeProcess, type WorkspaceRuntime } from '../../runtime'
import { captureStderr } from './spawn'

type Done = Extract<AgentEvent, { type: 'turn.done' }>
interface Turn {
  id: string
  parser: ReturnType<typeof createClaudeParser>
  done: Promise<void>
  finish(): void
  cancelled: boolean
  result?: Done
  usage?: UsageCounts
  partial?: boolean
  messages: Map<string, UsageCounts>
  contextTokens?: number
}
interface Pending {
  resolve(): void
  reject(error: Error): void
}

/** Claude's streaming control frames are distinct from Codex JSON-RPC. */
export function startClaudeSession(
  opts: SessionOpts,
  runtime: WorkspaceRuntime = machineRuntime
): RunningSession {
  const args = [
    ...buildClaudeArgs(opts),
    '--input-format=stream-json',
    '--replay-user-messages',
    '--permission-prompt-tool=stdio',
    ...(opts.resumeId ? [`--resume=${opts.resumeId}`] : [])
  ]
  const queue = createEventQueue()
  let proc: RuntimeProcess | undefined
  let exited = Promise.resolve()
  let initialized: Promise<void> | undefined
  let ready = false
  let active: Turn | undefined
  let closed = false
  let providerId = opts.resumeId
  let sessionState: string | undefined
  let steering = Promise.resolve()
  const controls = new Map<string, Pending>()
  const guidance = new Map<string, Pending & { turn: Turn; text: string; messageId?: string }>()
  const questions = new Map<
    string,
    { event: QuestionRequest; input: Rec; nativeId: string; sending: boolean }
  >()

  function write(frame: unknown): Promise<void> {
    const stream = proc?.child.stdin
    if (stream === undefined || stream.destroyed)
      return Promise.reject(new Error('Claude connection is closed'))
    return new Promise((resolve, reject) =>
      stream.write(JSON.stringify(frame) + '\n', (error) => (error ? reject(error) : resolve()))
    )
  }
  function response(requestId: string, payload: { response: unknown } | { error: string }) {
    return write({
      type: 'control_response',
      response: { request_id: requestId, subtype: 'error' in payload ? 'error' : 'success', ...payload }
    })
  }
  function control(subtype: string): Promise<void> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      controls.set(id, { resolve, reject })
      void write({ type: 'control_request', request_id: id, request: { subtype } }).catch((error: Error) => {
        controls.delete(id)
        reject(error)
      })
    })
  }
  function resolveQuestion(id: string): void {
    const pending = questions.get(id)
    if (pending === undefined) return
    questions.delete(id)
    queue.push({ type: 'question.resolved', turnId: pending.event.turnId, requestId: id })
  }
  function finish(reason: Done['stopReason']): void {
    const turn = active
    if (turn === undefined) return
    active = undefined
    for (const id of questions.keys()) resolveQuestion(id)
    for (const [id, pending] of guidance) {
      guidance.delete(id)
      pending.reject(new Error('The turn ended before guidance was acknowledged'))
    }
    queue.push({ type: 'turn.done', turnId: turn.id, stopReason: turn.cancelled ? 'cancelled' : reason })
    turn.finish()
  }
  function fail(error: Error): void {
    if (closed) return
    closed = true
    if (active !== undefined && !active.cancelled)
      queue.push(errorEvent(active.id, 'claude.connection', error.message, false))
    finish('error')
    for (const pending of controls.values()) pending.reject(error)
    controls.clear()
    proc?.terminate()
    queue.end()
  }
  function maybeFinish(): void {
    if (active?.result !== undefined && (sessionState === undefined || sessionState === 'idle'))
      finish(active.result.stopReason)
  }
  function request(frame: Rec): void {
    const nativeId = str(frame, 'request_id')
    const data = sub(frame, 'request') ?? {}
    if (nativeId === undefined) return
    if (str(data, 'subtype') !== 'can_use_tool' || active === undefined) {
      void response(nativeId, { error: 'Unsupported or expired Claude request' }).catch(fail)
      return
    }
    const input = structuredClone(sub(data, 'input') ?? {})
    const tool = str(data, 'tool_name') ?? 'Tool'
    const approval = tool !== 'AskUserQuestion'
    const parsed = questionRequest.safeParse({
      type: 'question.requested',
      requestId: randomUUID(),
      turnId: active.id,
      callId: str(data, 'tool_use_id'),
      blocking: true,
      ...(approval ? { purpose: 'approval' } : {}),
      questions: approval
        ? [
            {
              id: 'approval',
              header: tool,
              question: `${str(data, 'decision_reason') ?? 'Allow this tool call once?'}\n${JSON.stringify(input, null, 2)}`,
              options: [
                { label: 'Allow', description: 'Allow this call only' },
                { label: 'Deny', description: 'Decline this call' }
              ]
            }
          ]
        : list(input, 'questions').map((q, index) => ({
            id: String(index),
            header: str(q, 'header') ?? 'Question',
            question: str(q, 'question'),
            multiSelect: q['multiSelect'] === true,
            isOther: true,
            options: list(q, 'options').map((option) => ({
              label: str(option, 'label'),
              description: str(option, 'description') ?? ''
            }))
          }))
    })
    if (!parsed.success || parsed.data.questions.length === 0) {
      void response(nativeId, { error: 'Malformed Claude question' }).catch(fail)
      return
    }
    questions.set(parsed.data.requestId, { event: parsed.data, input, nativeId, sending: false })
    queue.push(parsed.data)
  }
  function receive(line: string): void {
    const frame = tryParseRecord(line)
    if (frame === undefined) {
      fail(new Error('Claude sent an invalid streaming record'))
      return
    }
    const type = str(frame, 'type')
    if (type === 'control_response') {
      const reply = sub(frame, 'response') ?? {}
      const id = str(reply, 'request_id') ?? ''
      const pending = controls.get(id)
      controls.delete(id)
      if (str(reply, 'subtype') === 'error')
        pending?.reject(new Error(str(reply, 'error') ?? 'Claude rejected the request'))
      else pending?.resolve()
      return
    }
    if (type === 'control_request') {
      request(frame)
      return
    }
    if (type === 'control_cancel_request') {
      for (const [id, pending] of questions) if (pending.nativeId === frame['request_id']) resolveQuestion(id)
      return
    }
    const nativeSession = str(frame, 'session_id')
    if (nativeSession !== undefined) providerId = nativeSession
    if (type === 'system' && str(frame, 'subtype') === 'session_state_changed') {
      sessionState = str(frame, 'state')
      maybeFinish()
      return
    }
    const turn = active
    if (turn === undefined) return
    if (type === 'assistant' && !frame['parent_tool_use_id']) {
      const message = sub(frame, 'message') ?? {}
      const measured = claudeUsage(sub(message, 'usage') ?? {}, turn.id, false)
      if (measured !== undefined) {
        turn.messages.set(str(message, 'id') ?? str(frame, 'uuid') ?? 'message', measured)
        turn.contextTokens = measured.inputTokens
        let total = turn.usage ?? { inputTokens: 0 }
        for (const counts of turn.messages.values()) total = addUsageCounts(total, counts)
        queue.push({
          type: 'usage',
          turnId: turn.id,
          scope: 'turn',
          contextTokens: turn.contextTokens,
          partial: turn.partial,
          ...total
        })
      }
    }
    if (type === 'user') {
      const id = str(frame, 'uuid') ?? ''
      const pending = guidance.get(id)
      if (pending !== undefined) {
        guidance.delete(id)
        queue.push({
          type: 'user.steer',
          turnId: pending.turn.id,
          text: pending.text,
          ...(pending.messageId === undefined ? {} : { messageId: pending.messageId })
        })
        pending.resolve()
      }
    }
    for (const event of turn.parser.parse(line)) {
      if (event.type === 'turn.started') continue
      if (event.type === 'turn.done') {
        turn.result = event
        continue
      }
      if (event.type === 'usage') {
        let counts: UsageCounts = event
        if (str(frame, 'subtype') !== 'success') {
          let measured: UsageCounts = { inputTokens: 0 }
          for (const message of turn.messages.values()) measured = addUsageCounts(measured, message)
          // Crash and budget-limit results can omit requests already measured above.
          if (measured.inputTokens > event.inputTokens) {
            counts = { ...measured, outputTokens: event.outputTokens || undefined }
            turn.partial = true
          }
        }
        turn.usage = turn.usage === undefined ? counts : addUsageCounts(turn.usage, counts)
        turn.messages.clear()
        queue.push({
          type: 'usage',
          turnId: turn.id,
          scope: 'turn',
          contextTokens: turn.contextTokens,
          partial: turn.partial,
          ...turn.usage
        })
      } else queue.push(event)
    }
    if (type === 'result') maybeFinish()
  }
  function connect(): Promise<void> {
    if (initialized !== undefined) return initialized
    proc = runtime.spawn('claude', args, {
      cwd: opts.worktreePath,
      env: { ...opts.env, CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' }
    })
    const child = proc.child
    const stderr = captureStderr(child)
    exited = new Promise((resolve) => {
      child.once('close', () => resolve())
      child.once('error', () => resolve())
    })
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      if (!closed && line.trim() !== '') receive(line)
    })
    child.once('error', fail)
    child.stdin.on('error', fail)
    child.once('close', () => {
      if (!closed) fail(new Error(stderr() || 'Claude connection closed'))
      lines.close()
    })
    child.stdout.once('end', () => {
      if (!closed) fail(new Error(stderr() || 'Claude output closed'))
    })
    initialized = control('initialize').then(() => {
      ready = true
    })
    return initialized
  }
  function user(text: string, images: PromptImage[], uuid = randomUUID()) {
    return {
      type: 'user',
      uuid,
      session_id: providerId ?? '',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'text', text },
          ...images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mimeType, data: image.data }
          }))
        ]
      }
    }
  }
  return {
    events: queue.iterable,
    providerSessionId: () => providerId,
    async send(text, images = []) {
      if (closed || active !== undefined) throw new Error('Claude session is closed or already running')
      const id = randomUUID()
      let resolve!: () => void
      const turn: Turn = {
        id,
        parser: createClaudeParser(id),
        done: new Promise((done) => {
          resolve = done
        }),
        finish: () => resolve(),
        cancelled: false,
        messages: new Map()
      }
      active = turn
      sessionState = undefined
      queue.push({ type: 'turn.started', turnId: id, at: Date.now() })
      try {
        await connect()
        if (active !== turn || closed) return
        await write(user(text, images))
        await turn.done
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    },
    steer(text, images = [], messageId) {
      const turn = active
      if (turn === undefined || closed) return Promise.reject(new Error('There is no active turn to steer'))
      const work = steering
        .catch(() => undefined)
        .then(async () => {
          await Promise.race([connect(), turn.done])
          if (active !== turn || closed) throw new Error('The turn ended before guidance was delivered')
          const id = randomUUID()
          await new Promise<void>((resolve, reject) => {
            guidance.set(id, {
              turn,
              text,
              resolve,
              reject,
              ...(messageId === undefined ? {} : { messageId })
            })
            void write(user(text, images, id)).catch((error: Error) => {
              guidance.delete(id)
              reject(error)
            })
          })
        })
      steering = work
      return work
    },
    async answerQuestion(answer: QuestionAnswer) {
      const pending = questions.get(answer.requestId)
      if (pending === undefined || pending.sending)
        throw new Error('Question is no longer awaiting an answer')
      const answers = validateQuestionAnswers(pending.event, answer)
      for (const q of pending.event.questions) {
        const values = answers[q.id] ?? []
        if (
          values.length === 0 ||
          (!q.multiSelect && values.length !== 1) ||
          values.some(
            (value) => !value.trim() || (!q.isOther && !q.options?.some((option) => option.label === value))
          )
        )
          throw new Error('Select a valid answer')
      }
      const allowed = pending.event.purpose !== 'approval' || answers['approval']?.[0] === 'Allow'
      const updatedInput =
        pending.event.purpose === 'approval'
          ? pending.input
          : {
              ...pending.input,
              answers: Object.fromEntries(
                pending.event.questions.map((q) => [
                  q.question,
                  q.multiSelect ? answers[q.id] : answers[q.id]?.[0]
                ])
              )
            }
      pending.sending = true
      try {
        await response(pending.nativeId, {
          response: allowed
            ? { behavior: 'allow', updatedInput }
            : { behavior: 'deny', message: 'User declined this tool call' }
        })
        queue.push({
          type: 'question.answered',
          turnId: pending.event.turnId,
          requestId: answer.requestId,
          answers: visibleQuestionAnswers(pending.event, answers)
        })
        resolveQuestion(answer.requestId)
      } finally {
        pending.sending = false
      }
    },
    async cancel() {
      const turn = active
      if (turn === undefined) return
      turn.cancelled = true
      if (!ready) {
        fail(new Error('Claude startup cancelled'))
        await exited
        return
      }
      try {
        await control('interrupt')
        await turn.done
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    },
    async close() {
      if (!closed) {
        if (active !== undefined) active.cancelled = true
        fail(new Error('Claude session closed'))
      }
      await exited
    }
  }
}
