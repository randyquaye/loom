import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCodexThread } from '../src/main/agents/cli/codex-app-server'
import { setCodexQuotaObserver, startCodexSession } from '../src/main/agents/cli/codex-session'
import type { AgentEvent } from '../src/shared/events'
import type { SessionOpts } from '../src/shared/models'

vi.mock('../src/main/agents/cli/codex-app-server', () => ({ openCodexThread: vi.fn() }))
type Rpc = Awaited<ReturnType<typeof openCodexThread>>['rpc']
type Call = Parameters<Parameters<typeof openCodexThread>[1]>[0]
const opts: SessionOpts = {
  workspaceId: 'workspace',
  worktreePath: '/tmp/worktree',
  model: 'gpt-6.1-sol',
  effort: 'high',
  systemPromptAppend: ''
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()))
  setCodexQuotaObserver(null)
  vi.mocked(openCodexThread).mockReset()
})

async function harness(bootstrap?: Call) {
  let receive!: Parameters<typeof openCodexThread>[1]
  let disconnect!: (error: Error) => void
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
  vi.mocked(openCodexThread).mockImplementationOnce(async (_opts, listener) => {
    receive = listener
    if (bootstrap) listener(bootstrap, rpc)
    return { rpc, threadId: 'thread', close }
  })
  const session = startCodexSession(opts)
  cleanup.push(() => session.close())
  const sending = session.send('accepted work')
  await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledOnce())
  const emit = (call: Call) => receive(call, rpc)
  async function finish(error?: string) {
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread',
        turn: {
          id: 'turn',
          status: error ? 'failed' : 'completed',
          ...(error ? { error: { codexErrorInfo: error, message: 'Provider capacity error' } } : {})
        }
      }
    })
    await sending
  }
  return { session, rpc, emit, finish }
}

describe('Codex native quota feedback', () => {
  it('observes connection-level exhaustion during bootstrap with only the exhausted-window reset', async () => {
    const observe = vi.fn()
    const factory = vi.fn(() => observe)
    setCodexQuotaObserver(factory)
    const now = Math.floor(Date.now() / 1000)
    const h = await harness({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          primary: { usedPercent: 100, resetsAt: now + 30 },
          secondary: { usedPercent: 1, resetsAt: now + 900 },
          credits: { balance: 'private detail' },
          planType: 'team'
        }
      }
    })
    expect(factory).toHaveBeenCalledExactlyOnceWith('workspace')
    expect(observe).toHaveBeenCalledExactlyOnceWith({ resetAt: (now + 30) * 1000 })
    h.emit({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          primary: { usedPercent: 101, resetsAt: now + 40 },
          secondary: { usedPercent: 100, resetsAt: now + 60 }
        }
      }
    })
    expect(observe).toHaveBeenLastCalledWith({ resetAt: (now + 60) * 1000 })
    expect(h.rpc.request).toHaveBeenCalledExactlyOnceWith('turn/start', expect.anything())
    await h.finish()
  })

  it('leaves healthy, unknown, and sparse account updates unknown without clearing earlier exhaustion', async () => {
    const observe = vi.fn()
    setCodexQuotaObserver(() => observe)
    const h = await harness()
    for (const params of [
      undefined,
      {},
      { rateLimits: null },
      { rateLimits: { primary: { usedPercent: '100' } } },
      { rateLimits: { primary: { usedPercent: 99 } } },
      { rateLimits: { rateLimitReachedType: 'newUnknownValue' } }
    ])
      h.emit({ method: 'account/rateLimits/updated', params })
    expect(observe).not.toHaveBeenCalled()
    h.emit({
      method: 'account/rateLimits/updated',
      params: { rateLimits: { primary: { usedPercent: 100, resetsAt: null } } }
    })
    expect(observe).toHaveBeenCalledExactlyOnceWith({ resetAt: null })
    h.emit({
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: { primary: null, secondary: null, rateLimitReachedType: null, spendControlReached: null }
      }
    })
    h.emit({ method: 'account/updated', params: { authMode: null } })
    expect(observe).toHaveBeenCalledTimes(1)
    await h.finish()
  })

  it('reports explicit account limits while rejecting malformed or unusable reset timestamps', async () => {
    const observe = vi.fn()
    setCodexQuotaObserver(() => observe)
    const h = await harness()
    for (const resetsAt of [
      '2030000000',
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      0
    ]) {
      h.emit({
        method: 'account/rateLimits/updated',
        params: { rateLimits: { primary: { usedPercent: 100, resetsAt } } }
      })
      expect(observe).toHaveBeenLastCalledWith({ resetAt: null })
    }
    h.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { spendControlReached: true } } })
    h.emit({
      method: 'account/rateLimits/updated',
      params: { rateLimits: { rateLimitReachedType: 'workspace_owner_usage_limit_reached' } }
    })
    expect(observe).toHaveBeenCalledTimes(8)
    await h.finish()
  })

  it('observes typed failures only for this thread and preserves the accepted turn without replay', async () => {
    const observe = vi.fn()
    setCodexQuotaObserver(() => observe)
    const h = await harness()
    h.emit({
      method: 'error',
      params: { threadId: 'other-thread', turnId: 'turn', error: { codexErrorInfo: 'usageLimitExceeded' } }
    })
    h.emit({
      method: 'error',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        error: { codexErrorInfo: 'serverOverloaded', message: 'usageLimitExceeded' }
      }
    })
    expect(observe).not.toHaveBeenCalled()
    h.emit({
      method: 'error',
      params: {
        threadId: 'thread',
        turnId: 'turn',
        error: { codexErrorInfo: 'rateLimitExceeded', message: 'private provider text' },
        willRetry: true
      }
    })
    expect(observe).toHaveBeenCalledExactlyOnceWith({ resetAt: null })
    await h.finish('usageLimitExceeded')
    expect(observe).toHaveBeenCalledTimes(2)
    expect(h.rpc.request).toHaveBeenCalledExactlyOnceWith('turn/start', expect.anything())
    await h.session.close()
    const events: AgentEvent[] = []
    for await (const event of h.session.events) events.push(event)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'rateLimitExceeded', retryable: true })
    )
    expect(events.at(-1)).toMatchObject({ type: 'turn.done', stopReason: 'error' })
  })

  it('captures each session observer and ignores notifications after its session closes', async () => {
    const old = vi.fn()
    const replacement = vi.fn()
    setCodexQuotaObserver(() => old)
    const first = await harness()
    setCodexQuotaObserver(() => replacement)
    const second = await harness()
    const quota = {
      method: 'account/rateLimits/updated',
      params: { rateLimits: { primary: { usedPercent: 100 } } }
    }
    first.emit(quota)
    expect(old).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    second.emit(quota)
    expect(replacement).toHaveBeenCalledOnce()
    await first.finish()
    await first.session.close()
    first.emit(quota)
    expect(old).toHaveBeenCalledOnce()
    await second.finish()
  })

  it('keeps ordinary session completion intact when optional account observation is absent or fails', async () => {
    for (const factory of [
      () => undefined,
      () => () => {
        throw new Error('Account changed')
      }
    ]) {
      setCodexQuotaObserver(factory)
      const h = await harness()
      expect(() =>
        h.emit({
          method: 'account/rateLimits/updated',
          params: { rateLimits: { primary: { usedPercent: 100 } } }
        })
      ).not.toThrow()
      await h.finish()
      expect(h.rpc.request).toHaveBeenCalledExactlyOnceWith('turn/start', expect.anything())
    }
  })
})
