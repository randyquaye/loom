import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCodexThread } from '../src/main/agents/cli/codex-app-server'
import { startCodexSession, type RequestHandler } from '../src/main/agents/cli/codex-session'
import { agentEvent, type AgentEvent } from '../src/shared/events'
import type { SessionOpts } from '../src/shared/models'

vi.mock('../src/main/agents/cli/codex-app-server', () => ({ openCodexThread: vi.fn() }))
type Rpc = Awaited<ReturnType<typeof openCodexThread>>['rpc']
const opts: SessionOpts = {
  workspaceId: 'workspace',
  worktreePath: '/tmp/worktree',
  model: 'gpt-6.1-sol',
  effort: 'high',
  systemPromptAppend: ''
}
const cleanup: (() => Promise<void>)[] = []
afterEach(() => Promise.all(cleanup.splice(0).map((close) => close())))

async function harness(bootRequest = false) {
  vi.mocked(openCodexThread).mockReset()
  let disconnect!: (error: Error) => void
  let receive!: Parameters<typeof openCodexThread>[1]
  const rpc = {
    failure: undefined,
    closed: new Promise<Error>((resolve) => {
      disconnect = resolve
    }),
    request: vi.fn<Rpc['request']>().mockResolvedValue({ turn: { id: 'turn' } }),
    notify: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    reject: vi.fn(async () => {})
  }
  const close = vi.fn(async () => disconnect(new Error('Connection closed')))
  vi.mocked(openCodexThread).mockImplementation(async (_opts, listener) => {
    receive = listener
    if (bootRequest) listener({ id: 9, method: 'question' }, rpc)
    return { rpc, threadId: 'thread', close }
  })
  const onRequest = vi.fn<RequestHandler>((_call, reply) => reply({ answer: 'yes' }))
  const session = await startCodexSession(opts, onRequest)
  cleanup.push(() => session.close())
  const emit = (method: string, turn: Record<string, unknown>) =>
    receive({ method, params: { threadId: 'thread', turn } }, rpc)
  const receiveCall = (call: Parameters<typeof receive>[0]) => receive(call, rpc)
  return { session, rpc, disconnect, emit, close, onRequest, receiveCall }
}

describe('Persistent Codex session', () => {
  it('releases nonblocking questions immediately and steers answers with their original context', async () => {
    const h = await harness()
    const sending = h.session.send('work')
    await vi.waitFor(() => expect(h.rpc.request).toHaveBeenCalledTimes(1))
    h.receiveCall({
      id: 31,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'question',
        isBlocking: false,
        questions: [
          {
            id: 'pick',
            header: 'Choice',
            question: 'Which implementation?',
            options: [{ label: 'Existing', description: 'Reuse it' }]
          }
        ]
      }
    })
    expect(h.onRequest).not.toHaveBeenCalled()
    expect(h.rpc.respond).toHaveBeenCalledExactlyOnceWith(31, { answers: {} })
    const iterator = h.session.events[Symbol.asyncIterator]()
    const question = (await iterator.next()).value as Extract<AgentEvent, { type: 'question.requested' }>
    h.receiveCall({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 31 } })
    await h.session.answerQuestion!({ requestId: question.requestId, answers: { pick: ['Existing'] } })
    expect(h.rpc.request).toHaveBeenLastCalledWith(
      'turn/steer',
      expect.objectContaining({
        input: [{ type: 'text', text: expect.stringContaining('Which implementation?\nAnswer: Existing') }]
      })
    )
    expect(h.rpc.respond).toHaveBeenCalledTimes(1)
    h.emit('turn/completed', { id: 'turn', status: 'completed' })
    await sending
  })
  it('sends image bytes as native input instead of asking the model to read a path', async () => {
    const h = await harness()
    const sending = h.session.send('inspect', [{ label: 'pixel.png', mimeType: 'image/png', data: 'YWJj' }])
    await vi.waitFor(() =>
      expect(h.rpc.request).toHaveBeenCalledWith('turn/start', {
        threadId: 'thread',
        input: [
          { type: 'text', text: 'inspect' },
          { type: 'image', url: 'data:image/png;base64,YWJj' }
        ]
      })
    )
    h.emit('turn/completed', { id: 'turn', status: 'completed' })
    await sending
  })
  it('counts only the active turn when Codex reports cumulative thread usage', async () => {
    const h = await harness()
    const first = h.session.send('first')
    await vi.waitFor(() => expect(h.rpc.request).toHaveBeenCalledTimes(1))
    h.receiveCall({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        tokenUsage: {
          modelContextWindow: 475000,
          total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 },
          last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 }
        }
      }
    })
    h.emit('turn/completed', { id: 'turn', status: 'completed' })
    await first
    const second = h.session.send('second')
    h.emit('turn/started', { id: 'second' })
    h.receiveCall({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread',
        turnId: 'second',
        tokenUsage: {
          total: { inputTokens: 160, outputTokens: 25, cachedInputTokens: 40 },
          last: { inputTokens: 40, outputTokens: 3, cachedInputTokens: 8 }
        }
      }
    })
    h.receiveCall({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread',
        turnId: 'second',
        tokenUsage: {
          total: { inputTokens: 160, outputTokens: 25, cachedInputTokens: 40 },
          last: { inputTokens: 0, outputTokens: 0, totalTokens: 12 }
        }
      }
    })
    h.emit('turn/completed', { id: 'second', status: 'interrupted' })
    await second
    await h.session.close()
    const events: AgentEvent[] = []
    for await (const event of h.session.events) if (event.type === 'usage') events.push(event)
    expect(events).toMatchObject([
      {
        scope: 'turn',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        contextWindowTokens: 475000
      },
      { scope: 'turn', inputTokens: 60, outputTokens: 5, cacheReadInputTokens: 10, contextTokens: 40 },
      { scope: 'turn', inputTokens: 60, outputTokens: 5, cacheReadInputTokens: 10, contextTokens: 12 }
    ])
  })
  it('serializes guidance in the active turn without interrupting or starting another turn', async () => {
    const h = await harness()
    const sending = h.session.send('work')
    await vi.waitFor(() => expect(h.rpc.request).toHaveBeenCalledTimes(1))
    let accept!: (value: unknown) => void
    h.rpc.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve
        })
    )
    const first = h.session.steer!('first guidance', [], 'first-message')
    const second = h.session.steer!('second guidance', [], 'second-message')
    await vi.waitFor(() => expect(h.rpc.request).toHaveBeenCalledTimes(2))
    expect(h.rpc.request).toHaveBeenLastCalledWith('turn/steer', {
      threadId: 'thread',
      expectedTurnId: 'turn',
      input: [{ type: 'text', text: 'first guidance' }]
    })
    accept({ turnId: 'turn' })
    await Promise.all([first, second])
    expect(h.rpc.request).toHaveBeenCalledTimes(3)
    expect(h.rpc.request).toHaveBeenLastCalledWith('turn/steer', {
      threadId: 'thread',
      expectedTurnId: 'turn',
      input: [{ type: 'text', text: 'second guidance' }]
    })
    h.emit('turn/completed', { id: 'turn', status: 'completed' })
    await sending
    expect(h.close).not.toHaveBeenCalled()
    await h.session.close()
    const events: AgentEvent[] = []
    for await (const event of h.session.events) if (event.type === 'user.steer') events.push(event)
    expect(events).toMatchObject([
      { text: 'first guidance', messageId: 'first-message' },
      { text: 'second guidance', messageId: 'second-message' }
    ])
    await expect(h.session.steer!('too late')).rejects.toThrow()
  })

  it.each(['Allow', 'Deny'])('limits permission %s to the scope displayed for this turn', async (choice) => {
    const h = await harness()
    const sending = h.session.send('work')
    await vi.waitFor(() => expect(h.rpc.request).toHaveBeenCalledTimes(1))
    const events = h.session.events[Symbol.asyncIterator]()
    const permissions = {
      network: { enabled: true },
      fileSystem: {
        read: ['/tmp/input'],
        write: ['/tmp/export'],
        entries: [{ access: 'deny', path: { type: 'path', path: '/tmp/secrets' } }]
      }
    }
    const displayed = structuredClone(permissions)
    h.receiveCall({
      id: 21,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'permissions',
        cwd: '/tmp/project',
        reason: 'Export the report',
        permissions
      }
    })
    expect(h.onRequest).not.toHaveBeenCalled()
    expect(h.rpc.respond).not.toHaveBeenCalled()
    const event = (await events.next()).value as Extract<AgentEvent, { type: 'question.requested' }>
    const question = event.questions[0]!
    expect(event).toMatchObject({ purpose: 'approval', callId: 'permissions', blocking: true })
    expect(question.question).toContain('for this turn')
    expect(question.question).toContain('Export the report')
    expect(question.question).toContain('/tmp/export')
    expect(question.question).toContain('/tmp/secrets')
    expect(question.options?.map((option) => option.label)).toEqual(['Allow', 'Deny'])
    for (const values of [['Stop turn'], ['Allow', 'Deny']]) {
      await expect(
        h.session.answerQuestion!({ requestId: event.requestId, answers: { decision: values } })
      ).rejects.toThrow()
    }
    expect(h.rpc.respond).not.toHaveBeenCalled()
    permissions.fileSystem.write.push('/private')
    await h.session.answerQuestion!({ requestId: event.requestId, answers: { decision: [choice] } })
    expect(h.rpc.respond).toHaveBeenCalledExactlyOnceWith(21, {
      permissions: choice === 'Allow' ? displayed : {},
      scope: 'turn'
    })
    await events.next()
    h.emit('turn/completed', { id: 'turn', status: 'completed' })
    await sending
  })

  it.each([
    ['commandExecution', 'Allow', 'accept'],
    ['fileChange', 'Deny', 'decline'],
    ['commandExecution', 'Stop turn', 'cancel']
  ])('correlates %s approval decisions without automatic approval', async (kind, choice, decision) => {
    const h = await harness()
    const sending = h.session.send('work')
    await vi.waitFor(() => expect(h.rpc.request).toHaveBeenCalledTimes(1))
    const events = h.session.events[Symbol.asyncIterator]()
    const request = {
      id: 17,
      method: `item/${kind}/requestApproval`,
      params: {
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'tool',
        command: 'deploy preview',
        cwd: '/tmp/project',
        reason: 'Needs network access',
        grantRoot: '/tmp/output',
        networkApprovalContext: { host: 'preview.example', protocol: 'https' }
      }
    }
    h.receiveCall(request)
    expect(h.onRequest).not.toHaveBeenCalled()
    expect(h.rpc.respond).not.toHaveBeenCalled()
    const event = (await events.next()).value as Extract<AgentEvent, { type: 'question.requested' }>
    expect(agentEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event)
    expect(event).toMatchObject({ purpose: 'approval', callId: 'tool', blocking: true })
    const question = event.questions[0]!
    expect(question.question).toContain('Needs network access')
    expect(question.question).toContain(
      kind === 'fileChange' ? 'this session: /tmp/output' : 'preview.example'
    )
    expect(question.isOther).toBe(false)
    const answer = { requestId: event.requestId, answers: { decision: ['arbitrary text'] } }
    await expect(h.session.answerQuestion!(answer)).rejects.toThrow()
    expect(h.rpc.respond).not.toHaveBeenCalled()
    await h.session.answerQuestion!({ ...answer, answers: { decision: [choice!] } })
    expect(h.rpc.respond).toHaveBeenCalledExactlyOnceWith(17, { decision })
    expect((await events.next()).value).toMatchObject({
      type: 'question.answered',
      answers: { decision: [choice] }
    })
    expect((await events.next()).value).toMatchObject({
      type: 'question.resolved',
      requestId: event.requestId
    })
    h.receiveCall({ ...request, id: 18 })
    const expired = (await events.next()).value as typeof event
    h.receiveCall({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 18 } })
    await events.next()
    await expect(h.session.answerQuestion!({ ...answer, requestId: expired.requestId })).rejects.toThrow()
    expect(h.rpc.respond).toHaveBeenCalledTimes(1)
    h.emit('turn/completed', { id: 'turn', status: 'completed' })
    await sending
    expect(h.rpc.request).toHaveBeenCalledTimes(1)
  })

  it('correlates blocking answers once and expires questions when the provider resolves them', async () => {
    const h = await harness()
    const sending = h.session.send('work')
    await vi.waitFor(() => expect(h.rpc.request).toHaveBeenCalledTimes(1))
    const events = h.session.events[Symbol.asyncIterator]()
    const params = {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'item',
      isBlocking: true,
      questions: [
        {
          id: 'pick',
          header: 'Choose',
          question: 'Which?',
          isOther: true,
          options: [{ label: 'One', description: 'First option' }]
        }
      ]
    }
    h.receiveCall({ id: 7, method: 'item/tool/requestUserInput', params })
    expect(h.onRequest).not.toHaveBeenCalled()
    const event = (await events.next()).value as Extract<AgentEvent, { type: 'question.requested' }>
    expect(agentEvent.parse(JSON.parse(JSON.stringify(event)))).toEqual(event)
    expect(event).toMatchObject({
      type: 'question.requested',
      turnId: 'turn',
      blocking: true,
      questions: [{ ...params.questions[0], isSecret: false }]
    })
    let acknowledge!: () => void
    h.rpc.respond.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve
        })
    )
    const answer = { requestId: event.requestId, answers: { pick: ['One'] } }
    await expect(h.session.answerQuestion!({ ...answer, answers: { unrelated: ['One'] } })).rejects.toThrow()
    const replying = h.session.answerQuestion!(answer)
    await expect(h.session.answerQuestion!(answer)).rejects.toThrow()
    expect(h.rpc.respond).toHaveBeenCalledExactlyOnceWith(7, { answers: { pick: { answers: ['One'] } } })
    acknowledge()
    await replying
    expect((await events.next()).value).toMatchObject({
      type: 'question.answered',
      answers: { pick: ['One'] }
    })
    expect((await events.next()).value).toEqual({
      type: 'question.resolved',
      turnId: 'turn',
      requestId: event.requestId
    })
    h.receiveCall({ id: '7', method: 'item/tool/requestUserInput', params })
    const pending = (await events.next()).value as typeof event
    expect(pending.requestId).not.toBe(event.requestId)
    h.receiveCall({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: '7' } })
    expect((await events.next()).value).toMatchObject({
      type: 'question.resolved',
      requestId: pending.requestId
    })
    await expect(h.session.answerQuestion!({ ...answer, requestId: pending.requestId })).rejects.toThrow()
    expect(h.rpc.respond).toHaveBeenCalledTimes(1)
    h.receiveCall({ id: 8, method: 'item/tool/requestUserInput', params })
    const last = (await events.next()).value as typeof event
    const closing = h.session.close()
    await expect(h.session.answerQuestion!({ ...answer, requestId: last.requestId })).rejects.toThrow()
    await closing
    await sending
  })

  it('answers startup requests and preserves follow-ups despite late start acknowledgements', async () => {
    const h = await harness(true)
    let acknowledge!: (value: unknown) => void
    const accepted = new Promise((resolve) => {
      acknowledge = resolve
    })
    h.rpc.request.mockReturnValueOnce(accepted)
    const first = h.session.send('first')
    await vi.waitFor(() => expect(h.rpc.request).toHaveBeenCalledTimes(1))
    expect(h.onRequest).toHaveBeenCalledTimes(1)
    expect(h.rpc.respond).toHaveBeenCalledWith(9, { answer: 'yes' })
    h.emit('turn/started', { id: 'early' })
    h.emit('turn/completed', { id: 'early', status: 'completed' })
    await first
    const second = h.session.send('second')
    h.emit('turn/started', { id: 'turn' })
    acknowledge({ turn: { id: 'early' } })
    await Promise.resolve()
    h.emit('turn/completed', { id: 'turn', status: 'completed' })
    await second
    expect(h.session.providerSessionId?.()).toBe('thread')
  })

  it('keeps the turn busy until interruption completes and preserves the process', async () => {
    const h = await harness()
    const sending = h.session.send('work')
    await vi.waitFor(() => expect(h.rpc.request).toHaveBeenCalledWith('turn/start', expect.anything()))
    const cancelling = h.session.cancel()
    await vi.waitFor(() =>
      expect(h.rpc.request).toHaveBeenCalledWith('turn/interrupt', {
        threadId: 'thread',
        turnId: 'turn'
      })
    )
    await expect(h.session.send('too early')).rejects.toThrow()
    h.emit('turn/completed', { id: 'turn', status: 'interrupted' })
    await Promise.all([sending, cancelling])
    expect(h.close).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'close'] as const)('allows %s while initialization is pending', async (action) => {
    const h = await harness()
    expect(openCodexThread).not.toHaveBeenCalled()
    let aborted = false
    vi.mocked(openCodexThread).mockImplementationOnce(
      (_opts, _listener, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(signal.reason)
            },
            { once: true }
          )
        })
    )
    const sending = h.session.send('work')
    await h.session[action]()
    await sending
    expect(aborted).toBe(true)
    await h.session.close()
    const events: AgentEvent[] = []
    for await (const event of h.session.events) events.push(event)
    expect(events.map((event) => event.type)).toEqual(['turn.done'])
    expect(events[0]).toMatchObject({ stopReason: 'cancelled' })
  })

  it.each([false, true])('finishes active work once when closing intentionally: %s', async (intentional) => {
    const h = await harness()
    const sending = h.session.send('work')
    if (intentional) await h.session.close()
    else h.disconnect(new Error('Connection lost'))
    await sending
    const events: AgentEvent[] = []
    for await (const event of h.session.events) events.push(event)
    expect(events.filter((event) => event.type === 'turn.done')).toMatchObject([
      { stopReason: intentional ? 'cancelled' : 'error' }
    ])
    expect(events.filter((event) => event.type === 'error')).toHaveLength(intentional ? 0 : 1)
    await expect(h.session.send('after close')).rejects.toThrow()
  })
})
