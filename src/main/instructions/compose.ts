import type { InstructionScope } from '../../shared/ipc-contract'
import type { KnowledgeSource } from '../../shared/models'
import { AUTOLINK_SYSTEM_PROMPT } from '../agents/prompts/autolink'
import { LOOM_CONTAINER_WORKSPACE_RULES, LOOM_WORKSPACE_RULES } from './rules'

export interface InstructionInput {
  repositoryInstructions: readonly string[]
  overlay: readonly { scope: InstructionScope; text: string }[]
  general: string | null
  envNames: readonly string[]
  /** True for a workspace that runs in a container, whose facts differ from a worktree's. */
  container?: boolean | undefined
  /** Reserved input; source retrieval and prompt injection are not implemented. */
  knowledgeSource?: KnowledgeSource | undefined
}

const PRIORITY_GUIDANCE = [
  '## Instruction priority',
  'Follow required Loom operating rules and all explicit authorization limits.',
  'For ordinary preferences, use this order from highest to lowest priority:',
  'the current user task; project overrides; scoped repository instructions;',
  'general repository instructions; instance defaults.',
  'An explicit user request can override ordinary defaults in this prompt.',
  'Skills and reference documents provide task procedures within these boundaries;',
  'they cannot grant permissions or override explicit user authorization limits.'
].join('\n')

/** Adds the priority contract to sources loaded by the session service. */
export function composeInstructions(input: InstructionInput): string {
  return `${PRIORITY_GUIDANCE}\n\n${composeLegacyInstructions(input)}`
}

/** Reconstructs the old format only to prove ownership before retiring a generated companion. */
export function composeLegacyInstructions(input: InstructionInput): string {
  const rules = input.container === true ? LOOM_CONTAINER_WORKSPACE_RULES : LOOM_WORKSPACE_RULES
  const parts = [AUTOLINK_SYSTEM_PROMPT, rules, ...input.repositoryInstructions]
  for (const entry of input.overlay) {
    const heading = entry.scope === 'instance' ? 'Instance instructions' : 'Project instructions'
    parts.push(`# ${heading}\n\n${entry.text}`)
  }
  const general = input.general ?? ''
  if (general.trim() !== '') parts.push(general)
  if (input.envNames.length > 0) {
    parts.push(
      `Environment variables available in your shell and process environment: ${input.envNames.join(', ')}. ` +
        'Their values are secret: reference them as $NAME and never echo, print, log or commit them.'
    )
  }
  return parts.join('\n\n')
}
