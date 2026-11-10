import type { AuthStatus, ModelDescriptor, SessionOpts } from '../../../shared/models'
import type { AgentBackend, RunningSession } from '../types'
import { assertSessionOpts } from './args'
import { CLAUDE_MODELS } from './catalog'
import { startClaudeSession } from './claude-session'
import { cliAuthStatus } from './probe'
import { cliSessionTitle } from './title'

export const CLAUDE_BIN = 'claude'
export const CLAUDE_INSTALL_HINT =
  'Install the Claude Code CLI (npm i -g @anthropic-ai/claude-code), then run `claude` to log in'

export function createClaudeBackend(): AgentBackend {
  return {
    id: 'claude',
    kind: 'cli',

    authStatus(): Promise<AuthStatus> {
      return cliAuthStatus(CLAUDE_BIN, CLAUDE_INSTALL_HINT)
    },

    listModels(): Promise<ModelDescriptor[]> {
      return Promise.resolve(
        CLAUDE_MODELS.map((model) => ({ ...model, supportsSteering: true, supportsImages: true }))
      )
    },

    title(prompt: string, model: string): Promise<string | null> {
      return cliSessionTitle(CLAUDE_BIN, ['-p', '--model', model], prompt)
    },

    startSession(opts: SessionOpts): Promise<RunningSession> {
      assertSessionOpts('claude', opts)

      return Promise.resolve(startClaudeSession(opts))
    }
  }
}
