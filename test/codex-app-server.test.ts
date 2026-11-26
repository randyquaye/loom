import { spawn } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { openCodexThread } from '../src/main/agents/cli/codex-app-server'
import { createCodexBackend } from '../src/main/agents/cli/codex'
import type { SessionOpts } from '../src/shared/models'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: vi.fn()
}))

const opts: SessionOpts = {
  workspaceId: 'workspace',
  worktreePath: '/tmp/loom-worktree',
  model: 'gpt-6.1-sol',
  effort: 'high',
  systemPromptAppend: 'Keep workspace instructions.',
  env: { LOOM_WORKSPACE_ID: 'workspace' }
}

function server(failure?: Record<string, unknown>, pause?: string) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 0
        child.emit('close', 0, null)
      })
      return true
    })
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  const messages: { id?: number; method?: string; params?: Record<string, unknown> }[] = []
  const reply = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n')
  child.stdin.on('data', (chunk: Buffer) => {
    const message = JSON.parse(chunk.toString()) as (typeof messages)[number]
    messages.push(message)
    if (message.method?.startsWith('thread/') && message.method !== pause) {
      reply({
        id: message.id,
        ...(failure ?? { result: { thread: { id: message.params?.threadId ?? 'new-thread' } } })
      })
    }
  })
  return { child, messages, initialize: () => reply({ id: messages[0]?.id, result: {} }) }
}

describe('Codex app-server startup', () => {
  it('runs the registered backend through the persistent connection and refuses unsupported server requests', async () => {
    const { child, messages, initialize } = server()
    const session = await createCodexBackend().startSession(opts)
    const sending = session.send('work')
    const settled = sending.catch((error: unknown) => error)
    try {
      expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]).toEqual([
        '--config',
        'features.default_mode_request_user_input=true',
        'app-server',
        '--listen',
        'stdio://'
      ])
      initialize()
      await vi.waitFor(() => expect(messages.some((m) => m.method === 'turn/start')).toBe(true))
      child.stdout.write(JSON.stringify({ id: 'unsupported', method: 'unknown/request' }) + '\n')
      await vi.waitFor(() =>
        expect(messages).toContainEqual({
          id: 'unsupported',
          error: { code: -32601, message: 'Unsupported agent request: unknown/request' }
        })
      )
    } finally {
      await session.close()
      await settled
    }
  })

  it('preserves provider rejection details when stderr also contains warnings', async () => {
    const { child, initialize } = server({ error: { code: -32600, message: 'thread unavailable' } })
    const opening = openCodexThread({ ...opts, resumeId: 'saved-thread' }, () => {})
    child.stderr.write('An unrelated startup warning')
    initialize()
    await expect(opening).rejects.toMatchObject({ message: 'thread unavailable', code: -32600 })
  })

  it.each([false, true])(
    'retains bounded exit diagnostics after stdout closes (initialized: %s)',
    async (initialized) => {
      const { child, initialize } = server()
      const opening = openCodexThread(opts, () => {})
      if (initialized) initialize()
      const pending = initialized ? (await opening).rpc.request('turn/start', {}) : opening
      const outcome = pending.catch((error: unknown) => error)
      child.kill.mockImplementation(() => true)
      child.stdout.end()
      await new Promise((resolve) => setImmediate(resolve))
      const diagnostic = 'Invalid Codex configuration: ' + 'x'.repeat(9000)
      child.stderr.end(diagnostic)
      child.exitCode = 1
      child.emit('close', 1, null)
      const error = await outcome
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('Invalid Codex configuration')
      expect((error as Error).message).toHaveLength(8192)
      expect((error as Error).message).toBe(diagnostic.slice(0, 8192))
    }
  )

  it.each(['initialize', 'thread/resume'])('aborts pending %s and reaps its child', async (pause) => {
    const { child, messages, initialize } = server(undefined, pause)
    const controller = new AbortController()
    const opening = openCodexThread({ ...opts, resumeId: 'saved-thread' }, () => {}, controller.signal)
    const outcome = opening.catch((error: unknown) => error)
    if (pause !== 'initialize') {
      initialize()
      await vi.waitFor(() => expect(messages.some((message) => message.method === pause)).toBe(true))
    }
    controller.abort()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(child.exitCode).toBe(0)
  })
  it.each([undefined, 'saved-thread'])(
    'initializes before opening a thread (resume: %s)',
    async (resumeId) => {
      const { messages, initialize } = server()
      const opening = openCodexThread({ ...opts, resumeId }, () => {})
      expect(messages.map((message) => message.method)).toEqual(['initialize'])
      initialize()
      const connection = await opening
      try {
        expect(messages.map((message) => message.method)).toEqual([
          'initialize',
          'initialized',
          resumeId === undefined ? 'thread/start' : 'thread/resume'
        ])
        expect(connection.threadId).toBe(resumeId ?? 'new-thread')
        expect(messages[2]?.params).toEqual({
          cwd: opts.worktreePath,
          model: opts.model,
          developerInstructions: expect.stringContaining(opts.systemPromptAppend),
          config: { model_reasoning_effort: opts.effort },
          ...(resumeId === undefined ? {} : { threadId: resumeId, excludeTurns: true })
        })
        const [bin, args, options] = vi.mocked(spawn).mock.calls.at(-1)!
        expect([bin, args]).toEqual([
          'codex',
          ['--config', 'features.default_mode_request_user_input=true', 'app-server', '--listen', 'stdio://']
        ])
        expect(options?.cwd).toBe(opts.worktreePath)
        expect(options?.env?.LOOM_WORKSPACE_ID).toBe('workspace')
        expect(options?.env?.CODEX_HOME).toBe(process.env.CODEX_HOME)
        expect(options?.env?.PATH).toBe(process.env.PATH)
      } finally {
        await connection.close()
      }
    }
  )

  it.each([{ error: { code: -32600, message: 'thread unavailable' } }, { result: { thread: {} } }])(
    'rejects failed resumes without starting another conversation and reaps the process',
    async (failure) => {
      const { child, messages, initialize } = server(failure)
      const opening = openCodexThread({ ...opts, resumeId: 'saved-thread' }, () => {})
      initialize()
      await expect(opening).rejects.toThrow()
      expect(messages.map((message) => message.method)).toEqual([
        'initialize',
        'initialized',
        'thread/resume'
      ])
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      expect(child.exitCode).toBe(0)
    }
  )
})
