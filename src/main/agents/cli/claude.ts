import type { AuthStatus, ModelDescriptor, SessionOpts } from '../../../shared/models'
import type { AgentBackend, RunningSession } from '../types'
import { assertSessionOpts, buildClaudeArgs, buildClaudeResumeArgs } from './args'
import { CLAUDE_MODELS } from './catalog'
import { createClaudeParser } from './parse-claude'
import { cliAuthStatus } from './probe'
import { cliSessionTitle } from './title'
import { startLazyCliSession, type LazyCliPlan, type ProviderParser } from './spawn'

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
      return Promise.resolve(CLAUDE_MODELS)
    },

    title(prompt: string, model: string): Promise<string | null> {
      return cliSessionTitle(CLAUDE_BIN, ['-p', '--model', model], prompt)
    },

    startSession(opts: SessionOpts): Promise<RunningSession> {
      assertSessionOpts('claude', opts)

      return Promise.resolve(
        startLazyCliSession({
          bin: CLAUDE_BIN,
          cwd: opts.worktreePath,
          initialProviderSessionId: opts.resumeId,
          env: opts.env,
          createParser(): ProviderParser {
            const parser = createClaudeParser()
            return {
              parse: (line) => parser.parse(line),
              providerSessionId: () => parser.sessionId()
            }
          },
          plan(prompt: string, providerSessionId: string | undefined): LazyCliPlan {
            const session = providerSessionId ?? opts.resumeId
            // `claude -p` reads the prompt from stdin when no positional is given,
            // which keeps the first turn's text out of the process argv.
            return session
              ? { args: buildClaudeResumeArgs(opts, session, prompt), promptOnStdin: false }
              : { args: buildClaudeArgs(opts), promptOnStdin: true }
          }
        })
      )
    }
  }
}
