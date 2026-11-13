import type { AgentEvent, QuestionAnswer, ToolName } from '../../shared/events'
import type { AuthStatus, BackendId, ModelDescriptor, PromptImage, SessionOpts } from '../../shared/models'
import type { WorkspaceRuntime } from '../runtime/types'

/** A tool call normalized once, identically for events and for execution. */
export interface NormalizedTool {
  id: string
  name: ToolName
  args: unknown
  /** Native ID when supplied; legacy Gemini calls have only a generated UI ID. */
  providerCallId?: string
}

/** A live session: push user turns in, consume normalized events out. */
export interface RunningSession {
  send(text: string, images?: PromptImage[]): Promise<void>
  /** Adds guidance to the active turn; resolves when the backend accepts it. */
  steer?(text: string, images?: PromptImage[], messageId?: string): Promise<void>
  /** Answers a pending blocking question without starting another turn. */
  answerQuestion?(answer: QuestionAnswer): Promise<void>
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
  /** `runtime` is where a CLI backend starts its process; omitted means this machine. */
  startSession(opts: SessionOpts, runtime?: WorkspaceRuntime): Promise<RunningSession>
  /** Optional: a name of at most five words for a session, derived from its first prompt. */
  title?(prompt: string, model: string, runtime?: WorkspaceRuntime): Promise<string | null>
}
