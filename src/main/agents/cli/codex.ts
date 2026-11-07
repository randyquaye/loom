import type { AuthStatus, ModelDescriptor, SessionOpts } from '../../../shared/models'
import type { AgentBackend, RunningSession } from '../types'
import { assertSessionOpts, buildCodexArgs, buildCodexResumeArgs } from './args'
import { CODEX_MODELS } from './catalog'
import { createCodexParser } from './parse-codex'
import { cliAuthStatus } from './probe'
import { cliSessionTitle } from './title'
import { startLazyCliSession, type LazyCliPlan, type ProviderParser } from './spawn'

export const CODEX_BIN = 'codex'
export const CODEX_INSTALL_HINT = 'Install the Codex CLI (npm i -g @openai/codex), then run `codex login`'

export function createCodexBackend(): AgentBackend {
  return {
    id: 'codex',
    kind: 'cli',

    authStatus(): Promise<AuthStatus> {
      return cliAuthStatus(CODEX_BIN, CODEX_INSTALL_HINT)
    },

    listModels(): Promise<ModelDescriptor[]> {
      return Promise.resolve(CODEX_MODELS)
    },

    title(prompt: string, model: string): Promise<string | null> {
      return cliSessionTitle(CODEX_BIN, ['exec', '--skip-git-repo-check', '-m', model], prompt)
    },

    startSession(opts: SessionOpts): Promise<RunningSession> {
      // Renderer-supplied model/effort/path are validated before anything is
      // turned into argv; an unknown model rejects here rather than spawning.
      assertSessionOpts('codex', opts)

      return Promise.resolve(
        startLazyCliSession({
          bin: CODEX_BIN,
          cwd: opts.worktreePath,
          initialProviderSessionId: opts.resumeId,
          env: opts.env,
          createParser(): ProviderParser {
            const parser = createCodexParser()
            return {
              parse: (line) => parser.parse(line),
              providerSessionId: () => parser.threadId()
            }
          },
          plan(prompt: string, providerSessionId: string | undefined): LazyCliPlan {
            const thread = providerSessionId ?? opts.resumeId
            // First turn has no thread id yet, so the prompt goes over stdin
            // (`codex exec` reads instructions from a piped stdin).
            return thread
              ? { args: buildCodexResumeArgs(thread, prompt), promptOnStdin: false }
              : { args: buildCodexArgs(opts), promptOnStdin: true }
          }
        })
      )
    }
  }
}
