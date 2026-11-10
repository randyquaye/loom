import { spawn } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeBackend } from '../src/main/agents/cli/claude'
import type { AgentEvent } from '../src/shared/events'
import type { SessionOpts } from '../src/shared/models'

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcessModule>()),
  spawn: vi.fn()
}))
const opts: SessionOpts = {
  workspaceId: 'w',
  worktreePath: '/tmp',
  model: 'sonnet',
  effort: 'high',
  systemPromptAppend: 'Preserve instructions',
  env: { LOOM_WORKSPACE_ID: 'w' }
}

async function fixture(pauseInitialize = false) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => {
      child.exitCode = 0
      queueMicrotask(() => child.emit('close', 0, null))
      return true
    })
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  const sent: Record<string, unknown>[] = []
  const emit = (frame: unknown) => child.stdout.write(JSON.stringify(frame) + '\n')
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const frame = JSON.parse(line) as Record<string, unknown>
      sent.push(frame)
      if (
        frame.type === 'control_request' &&
        !(pauseInitialize && (frame.request as { subtype?: string }).subtype === 'initialize')
      )
        emit({
          type: 'control_response',
          response: { subtype: 'success', request_id: frame.request_id, response: {} }
        })
    }
  })
  const session = await createClaudeBackend().startSession(opts)
  const events: AgentEvent[] = []
  const collected = (async () => {
    for await (const event of session.events) events.push(event)
  })()
  const userFrames = () => sent.filter((frame) => frame.type === 'user')
  async function begin() {
    const sending = session.send('work')
    await vi.waitFor(() => expect(userFrames()).toHaveLength(1))
    emit({ type: 'system', subtype: 'init', session_id: 'native-session' })
    emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    return { sending }
  }
  function result(input = 10, output = 4) {
    emit({
      type: 'result',
      subtype: 'success',
      session_id: 'native-session',
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2
      }
    })
  }
  const idle = () => emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
  async function close() {
    await session.close()
    await collected
  }
  return { child, session, events, emit, sent, userFrames, begin, result, idle, close }
}

describe('Claude streaming session', () => {
  it('cancels pending initialization without delivering a prompt or hanging', async () => {
    const f = await fixture(true)
    const sending = f.session.send('never sent')
    let cancelling: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(f.sent).toHaveLength(1))
      cancelling = f.session.cancel()
      await vi.waitFor(() => expect(f.child.kill).toHaveBeenCalled())
      await cancelling
      await sending
      expect(f.userFrames()).toHaveLength(0)
      expect(f.events.at(-1)).toMatchObject({ type: 'turn.done', stopReason: 'cancelled' })
    } finally {
      await f.close()
      await sending
      await cancelling
    }
  })
  it('retains measured request usage when the connection fails before a final result', async () => {
    const f = await fixture()
    try {
      const { sending } = await f.begin()
      const message = {
        type: 'assistant',
        message: {
          id: 'request-1',
          content: [],
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 3
          }
        }
      }
      f.emit(message)
      f.emit(message)
      f.emit({
        ...message,
        parent_tool_use_id: 'subagent',
        message: { ...message.message, id: 'nested', usage: { input_tokens: 999, output_tokens: 999 } }
      })
      f.child.stderr.write('connection lost')
      f.child.emit('error', new Error('connection lost'))
      await sending
      await vi.waitFor(() => expect(f.events.some((event) => event.type === 'turn.done')).toBe(true))
      expect(f.events.filter((event) => event.type === 'usage').at(-1)).toMatchObject({
        inputTokens: 17,
        cacheReadInputTokens: 4,
        cacheWriteInputTokens: 3
      })
      expect(f.events.filter((event) => event.type === 'usage').at(-1)?.outputTokens).toBeUndefined()
      expect(f.events.at(-1)).toMatchObject({ type: 'turn.done', stopReason: 'error' })
    } finally {
      await f.close()
    }
  })
  it('preserves launch settings and delivers first-prompt images over stdin', async () => {
    const f = await fixture()
    try {
      const sending = f.session.send('describe', [
        { label: 'photo.png', mimeType: 'image/png', data: 'aW1hZ2U=' }
      ])
      await vi.waitFor(() => expect(f.userFrames()).toHaveLength(1))
      const [, args, options] = vi.mocked(spawn).mock.calls.at(-1)!
      expect(args).toEqual(
        expect.arrayContaining([
          '--input-format=stream-json',
          '--replay-user-messages',
          '--permission-prompt-tool=stdio',
          '--append-system-prompt=Preserve instructions'
        ])
      )
      expect(args).not.toContain('describe')
      expect(options?.env).toMatchObject({ LOOM_WORKSPACE_ID: 'w', CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' })
      expect(f.userFrames()[0]).toMatchObject({
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }
          ]
        }
      })
      f.result()
      f.idle()
      await sending
    } finally {
      await f.close()
    }
  })

  it('acknowledges guidance in the same turn and waits for native idle across results', async () => {
    const f = await fixture()
    try {
      const { sending } = await f.begin()
      const steering = f.session.steer!('focus on ordering')
      let acknowledged = false
      void steering.then(() => {
        acknowledged = true
      })
      await vi.waitFor(() => expect(f.userFrames()).toHaveLength(2))
      expect(acknowledged).toBe(false)
      f.emit(f.userFrames()[1])
      await steering
      f.result()
      await new Promise((resolve) => setImmediate(resolve))
      expect(f.events.filter((e) => e.type === 'turn.done')).toHaveLength(0)
      f.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'guided result' }] } })
      f.result(7, 2)
      f.idle()
      await sending
      await vi.waitFor(() => expect(f.events.some((event) => event.type === 'turn.done')).toBe(true))
      expect(f.events.filter((e) => e.type === 'turn.started')).toHaveLength(1)
      expect(f.events.filter((e) => e.type === 'turn.done')).toHaveLength(1)
      const guidance = f.events.find((e) => e.type === 'user.steer')!
      expect(guidance).toMatchObject({
        turnId: f.events.find((e) => e.type === 'turn.started')!.turnId,
        text: 'focus on ordering'
      })
      expect(f.sent.filter((frame) => frame.type === 'control_request')).toHaveLength(1)
      expect(f.events.filter((e) => e.type === 'usage').at(-1)).toMatchObject({
        inputTokens: 27,
        outputTokens: 6,
        cacheReadInputTokens: 6,
        cacheWriteInputTokens: 4
      })
      expect(f.session.providerSessionId?.()).toBe('native-session')
    } finally {
      await f.close()
    }
  })

  it('routes multi-select questions through the existing answer lifecycle and native request identity', async () => {
    const f = await fixture()
    try {
      const { sending } = await f.begin()
      f.emit({
        type: 'control_request',
        request_id: 'native-question',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'call',
          input: {
            questions: [
              {
                header: 'Scope',
                question: 'Which parts?',
                multiSelect: true,
                options: [
                  { label: 'UI', description: 'Interface' },
                  { label: 'Backend', description: 'Delivery' }
                ]
              }
            ]
          }
        }
      })
      await vi.waitFor(() => expect(f.events.some((e) => e.type === 'question.requested')).toBe(true))
      const request = f.events.find((e) => e.type === 'question.requested') as Extract<
        AgentEvent,
        { type: 'question.requested' }
      >
      expect(request.questions[0]).toMatchObject({ multiSelect: true, isOther: true })
      expect(f.sent.filter((frame) => frame.type === 'control_response')).toHaveLength(0)
      await f.session.answerQuestion!({
        requestId: request.requestId,
        answers: { [request.questions[0]!.id]: ['UI', 'Backend'] }
      })
      expect(f.sent.at(-1)).toMatchObject({
        type: 'control_response',
        response: {
          request_id: 'native-question',
          response: { behavior: 'allow', updatedInput: { answers: { 'Which parts?': ['UI', 'Backend'] } } }
        }
      })
      await expect(f.session.answerQuestion!({ requestId: request.requestId, answers: {} })).rejects.toThrow()
      f.result()
      f.idle()
      await sending
      expect(f.events.some((e) => e.type === 'question.answered')).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('requires explicit approval and rejects expired tool decisions', async () => {
    const f = await fixture()
    try {
      const { sending } = await f.begin()
      f.emit({
        type: 'control_request',
        request_id: 'permission',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm important.txt' } }
      })
      await vi.waitFor(() => expect(f.events.some((e) => e.type === 'question.requested')).toBe(true))
      const request = f.events.find((e) => e.type === 'question.requested') as Extract<
        AgentEvent,
        { type: 'question.requested' }
      >
      expect(request.purpose).toBe('approval')
      expect(f.sent.filter((frame) => frame.type === 'control_response')).toHaveLength(0)
      await expect(
        f.session.answerQuestion!({ requestId: request.requestId, answers: { approval: ['maybe'] } })
      ).rejects.toThrow()
      f.emit({ type: 'control_cancel_request', request_id: 'permission' })
      await vi.waitFor(() => expect(f.events.some((e) => e.type === 'question.resolved')).toBe(true))
      await expect(
        f.session.answerQuestion!({ requestId: request.requestId, answers: { approval: ['Allow'] } })
      ).rejects.toThrow()
      f.result()
      f.idle()
      await sending
    } finally {
      await f.close()
    }
  })

  it('cancels natively, keeps reported usage, and accepts the next turn without restarting', async () => {
    const f = await fixture()
    try {
      const { sending } = await f.begin()
      const cancelling = f.session.cancel()
      await vi.waitFor(() =>
        expect(f.sent.some((frame) => (frame.request as { subtype?: string })?.subtype === 'interrupt')).toBe(
          true
        )
      )
      f.result()
      f.idle()
      await cancelling
      await sending
      const first = f.events.find((e) => e.type === 'turn.done')!
      expect(first).toMatchObject({ stopReason: 'cancelled' })
      expect(f.events.some((e) => e.type === 'usage' && e.turnId === first.turnId)).toBe(true)
      const next = f.session.send('continue')
      await vi.waitFor(() => expect(f.userFrames()).toHaveLength(2))
      f.result()
      f.idle()
      await next
      expect(
        vi
          .mocked(spawn)
          .mock.calls.filter(([bin]) => bin === 'claude')
          .at(-1)?.[2]?.cwd
      ).toBe('/tmp')
      const boundaries = f.events.filter((e) => e.type === 'turn.started')
      expect(boundaries).toHaveLength(2)
      expect(boundaries[0]!.turnId).not.toBe(boundaries[1]!.turnId)
      expect(f.child.kill).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
})
