import type { AgentEvent, ToolName } from '../../shared/events'
import type { AuthStatus, BackendId, ModelDescriptor, SessionOpts } from '../../shared/models'

/** A tool call normalized once, identically for events and for execution. */
export interface NormalizedTool {
  id: string
  name: ToolName
  args: unknown
}

/** A live session: push user turns in, consume normalized events out. */
export interface RunningSession {
  send(text: string): Promise<void>
  cancel(): Promise<void>
  close(): Promise<void>
  events: AsyncIterable<AgentEvent>
  /** Provider-side session/thread id, for resuming after an app restart. */
  providerSessionId?(): string | undefined
}

/**
 * The seam between the two execution paths (CLI adapters in agents/cli,
 * own agent loop in agents/loop) and everything above them.
 */
export interface AgentBackend {
  readonly id: BackendId
  readonly kind: 'cli' | 'loop'
  authStatus(): Promise<AuthStatus>
  listModels(): Promise<ModelDescriptor[]>
  startSession(opts: SessionOpts): Promise<RunningSession>
  /** Optional: a name of at most five words for a session, derived from its first prompt. */
  title?(prompt: string, model: string): Promise<string | null>
}
