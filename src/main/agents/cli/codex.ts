import type { AuthStatus, ModelDescriptor, SessionOpts } from '../../../shared/models'
import type { WorkspaceRuntime } from '../../runtime'
import type { AgentBackend, RunningSession } from '../types'
import { assertSessionOpts } from './args'
import { CODEX_MODELS } from './catalog'
import { cliAuthStatus } from './probe'
import { cliSessionTitle } from './title'
import { startCodexSession } from './codex-session'

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
      return Promise.resolve(
        CODEX_MODELS.map((model) => ({ ...model, supportsSteering: true, supportsImages: true }))
      )
    },

    title(prompt: string, model: string, runtime?: WorkspaceRuntime): Promise<string | null> {
      return cliSessionTitle(CODEX_BIN, ['exec', '--skip-git-repo-check', '-m', model], prompt, runtime)
    },

    startSession(opts: SessionOpts, runtime?: WorkspaceRuntime): Promise<RunningSession> {
      // Renderer-supplied model/effort/path are validated before anything is
      // turned into argv; an unknown model rejects here rather than spawning.
      assertSessionOpts('codex', opts)

      return Promise.resolve(startCodexSession(opts, undefined, runtime))
    }
  }
}
