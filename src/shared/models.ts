export type BackendId = 'codex' | 'claude' | 'gemini' | 'qwen'
export const BACKEND_IDS: BackendId[] = ['codex', 'claude', 'gemini', 'qwen']

/** Integrations whose credential Loom stores itself, unlike the CLI-owned logins. */
export type IntegrationId = 'linear'
export const INTEGRATION_IDS: IntegrationId[] = ['linear']

/** Everything the encrypted secret store may hold: provider API keys plus integration keys. */
export type SecretId = BackendId | IntegrationId

/** Single source for both the union and the IPC zod enum, so they cannot drift apart. */
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type Effort = (typeof EFFORTS)[number]

/**
 * Estimated context windows per model family, for the badge's usage meter.
 * Estimates only: providers do not expose the live window through the CLIs.
 */
export function contextWindowFor(model: string): number {
  if (/gemini/.test(model)) return 1_000_000
  if (/qwen/.test(model)) return 128_000
  if (/gpt-6/.test(model)) return 400_000
  if (/gpt-/.test(model)) return 256_000
  return 200_000
}

export interface ModelDescriptor {
  id: string
  label: string
  efforts: Effort[]
}

export interface SessionOpts {
  workspaceId: string
  worktreePath: string
  model: string
  effort: Effort
  systemPromptAppend: string
  resumeId?: string | undefined
  /** LOOM_* workspace env merged into spawned agent processes. */
  env?: Record<string, string> | undefined
  /** Local plugin dir (the bundled Loom skill) for CLIs that accept --plugin-dir. */
  pluginDir?: string | undefined
}

export type AuthStatus =
  | { state: 'ready' }
  | { state: 'needs-login'; hint: string }
  | { state: 'needs-key'; hint: string }
  | { state: 'error'; message: string }
