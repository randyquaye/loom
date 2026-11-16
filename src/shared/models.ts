export type BackendId = 'codex' | 'claude' | 'gemini' | 'qwen'
export const BACKEND_IDS: BackendId[] = ['codex', 'claude', 'gemini', 'qwen']

/** Integrations whose credential Loom stores itself, unlike the CLI-owned logins. */
export type IntegrationId = 'linear' | 'elevenlabs'

/** Everything the encrypted secret store may hold: provider API keys plus integration keys. */
export type SecretId = BackendId | IntegrationId

/** Single source for both the union and the IPC zod enum, so they cannot drift apart. */
export const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type Effort = (typeof EFFORTS)[number]

/** Display names; the ids stay terse because backends and storage use them verbatim. */
export const EFFORT_LABELS: Record<Effort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra'
}

/**
 * Fallback context windows when the provider does not report its live window.
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
  supportsSteering?: boolean
  supportsImages?: boolean
}

/** Reserved configuration for the future shared handbook and skill repository. */
export interface KnowledgeSource {
  kind: 'github'
  repositoryUrl: string
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
  /** Optional local plugin directory for CLIs that accept --plugin-dir. */
  pluginDir?: string | undefined
  /** Reserved input; providers do not retrieve or load this source yet. */
  knowledgeSource?: KnowledgeSource | undefined
  /** The modes stamped on a cloud workspace; absent, each CLI's own settings decide. */
  modes?: AgentModes | undefined
}

/**
 * How much an agent may do unasked in a cloud workspace. Claude: `auto` has a second model
 * review each action; Codex: `sandbox` confines commands to the checkout and asks before
 * going further. `bypass` never asks.
 */
export const CLAUDE_MODES = ['auto', 'bypass'] as const
export const CODEX_MODES = ['sandbox', 'bypass'] as const
export type ClaudeMode = (typeof CLAUDE_MODES)[number]
export type CodexMode = (typeof CODEX_MODES)[number]

export interface AgentModes {
  claude: ClaudeMode
  codex: CodexMode
}

export const DEFAULT_AGENT_MODES: AgentModes = { claude: 'auto', codex: 'sandbox' }

/** Image bytes captured when a prompt is accepted; queued turns do not reread the path. */
export interface PromptImage {
  label: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  data: string
}

export type AuthStatus =
  | { state: 'ready' }
  | { state: 'not-installed'; hint: string }
  | { state: 'needs-login'; hint: string }
  | { state: 'needs-key'; hint: string }
  | { state: 'error'; message: string }
