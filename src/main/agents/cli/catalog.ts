import type { BackendId, Effort, ModelDescriptor } from '../../../shared/models'

/**
 * Static catalogs, deliberately small. Loom never asks a CLI which models exist
 * (that would start a billed session), so the list is pinned here and the
 * `efforts` for each entry are the ones the local CLI actually advertises:
 * claude 2.x `--help` lists --effort low/medium/high/xhigh/max; the installed
 * codex binary's reasoning-effort enum is low/medium/high/xhigh/max/ultra.
 * Versioned claude ids are the full names the installed binary bundles; the
 * three aliases stay as "(latest)" pointers because `--model` accepts both.
 */
const CODEX_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const CLAUDE_EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const CODEX_MODELS: ModelDescriptor[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: CODEX_EFFORTS },
  { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', efforts: CODEX_EFFORTS },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: CODEX_EFFORTS },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: CODEX_EFFORTS },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: CODEX_EFFORTS },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', efforts: CODEX_EFFORTS },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: CODEX_EFFORTS }
]

export const CLAUDE_MODELS: ModelDescriptor[] = [
  { id: 'sonnet', label: 'Claude Sonnet (latest)', efforts: CLAUDE_EFFORTS },
  { id: 'opus', label: 'Claude Opus (latest)', efforts: CLAUDE_EFFORTS },
  { id: 'fable', label: 'Claude Fable (latest)', efforts: CLAUDE_EFFORTS },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', efforts: CLAUDE_EFFORTS },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', efforts: CLAUDE_EFFORTS },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', efforts: CLAUDE_EFFORTS },
  { id: 'claude-fable-5', label: 'Claude Fable 5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', efforts: CLAUDE_EFFORTS }
]

const CATALOGS: Partial<Record<BackendId, ModelDescriptor[]>> = {
  codex: CODEX_MODELS,
  claude: CLAUDE_MODELS
}

export function findModel(backend: 'codex' | 'claude', id: string): ModelDescriptor | undefined {
  return CATALOGS[backend]?.find((m) => m.id === id)
}
