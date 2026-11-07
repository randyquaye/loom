import type { SecretStore } from '../secrets'
import { createClaudeBackend } from './cli/claude'
import { createCodexBackend } from './cli/codex'
import { createLoopBackend } from './loop/runner'
import { registerBackend } from './registry'

/** Single place where the four execution paths attach to the session service. */
export function registerBackends(secrets: SecretStore): void {
  registerBackend(createCodexBackend())
  registerBackend(createClaudeBackend())
  registerBackend(createLoopBackend('qwen', { getKey: () => secrets.get('qwen') }))
  registerBackend(createLoopBackend('gemini', { getKey: () => secrets.get('gemini') }))
}
