import { version } from '../../../../package.json'
import type { CodexMode, SessionOpts } from '../../../shared/models'
import { assertSessionOpts } from './args'
import { isRec, str, sub } from './record'
import { createRpcTransport, type RpcCall } from './rpc'
import { machineRuntime, type WorkspaceRuntime } from '../../runtime'
import { captureStderr } from './spawn'

/** Codex's own sandbox and approval settings for each mode Loom stamps on a cloud workspace. */
const CODEX_SECURITY: Record<CodexMode, { sandbox: string; approvalPolicy: string }> = {
  sandbox: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  bypass: { sandbox: 'danger-full-access', approvalPolicy: 'never' }
}

/** Opens a persistent connection without starting a turn; the owner must close it. */
export async function openCodexThread(
  opts: SessionOpts,
  onCall: (call: RpcCall, rpc: ReturnType<typeof createRpcTransport>) => void,
  signal?: AbortSignal,
  runtime: WorkspaceRuntime = machineRuntime
) {
  assertSessionOpts('codex', opts)
  signal?.throwIfAborted()
  // Enable native questions for ordinary turns without changing the user's config file.
  const proc = runtime.spawn(
    'codex',
    ['--config', 'features.default_mode_request_user_input=true', 'app-server', '--listen', 'stdio://'],
    { cwd: opts.worktreePath, env: opts.env }
  )
  const child = proc.child
  const stderr = captureStderr(child)
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve())
    child.once('error', () => resolve())
  })
  const rpc = createRpcTransport(child, (call) => onCall(call, rpc))
  const abort = (): void => proc.terminate()
  signal?.addEventListener('abort', abort, { once: true })

  async function close(): Promise<void> {
    proc.terminate()
    await exited
  }

  function diagnosticError(error: unknown): Error {
    const detail = stderr()
    if (detail !== '') return new Error(detail, { cause: error })
    return error instanceof Error ? error : new Error(String(error))
  }

  const closed = rpc.closed.then(async (error) => {
    await close()
    return diagnosticError(error)
  })

  async function request(method: string, params?: unknown): Promise<unknown> {
    try {
      return await rpc.request(method, params)
    } catch (error) {
      // A transport failure must reap the process before collecting its final stderr.
      if (error === rpc.failure) throw await closed
      throw error
    }
  }

  try {
    await rpc.request('initialize', { clientInfo: { name: 'loom', title: 'Loom', version } })
    await rpc.notify('initialized')
    // Without a stamped mode, security settings continue to come from the user's Codex config.
    const params = {
      cwd: opts.worktreePath,
      model: opts.model,
      developerInstructions: opts.systemPromptAppend,
      config: { model_reasoning_effort: opts.effort },
      ...(opts.modes === undefined ? {} : CODEX_SECURITY[opts.modes.codex])
    }
    const result =
      opts.resumeId === undefined
        ? await rpc.request('thread/start', params)
        : await rpc.request('thread/resume', { ...params, threadId: opts.resumeId, excludeTurns: true })
    const thread = isRec(result) ? sub(result, 'thread') : undefined
    const threadId = thread === undefined ? undefined : str(thread, 'id')
    if (threadId === undefined || threadId === '') throw new Error('Codex returned no thread ID')
    return {
      rpc: { closed, request, notify: rpc.notify, respond: rpc.respond, reject: rpc.reject },
      threadId,
      close
    }
  } catch (error) {
    await close()
    signal?.throwIfAborted()
    throw error === rpc.failure ? diagnosticError(error) : error
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
