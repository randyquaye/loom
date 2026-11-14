import { create } from 'zustand'
import {
  CLAUDE_MODES,
  CODEX_MODES,
  DEFAULT_AGENT_MODES,
  type AgentModes,
  type ClaudeMode,
  type CodexMode
} from '../../shared/models'

const KEY = 'loom.preferences'

interface Preferences {
  completionSoundEnabled: boolean
  steerByDefault: boolean
  /** The permission mode each agent starts in, in cloud workspaces created from here on. */
  agentModes: AgentModes
}

/** What was saved, if it is still a choice on offer; otherwise the default. */
function oneOf<T extends string>(choices: readonly T[], saved: unknown, fallback: T): T {
  return choices.find((choice) => choice === saved) ?? fallback
}

function loadPreferences(): Preferences {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as {
      completionSoundEnabled?: unknown
      steerByDefault?: unknown
      agentModes?: { claude?: unknown; codex?: unknown }
    } | null
    return {
      completionSoundEnabled: saved?.completionSoundEnabled !== false,
      steerByDefault: saved?.steerByDefault === true,
      agentModes: {
        claude: oneOf(CLAUDE_MODES, saved?.agentModes?.claude, DEFAULT_AGENT_MODES.claude),
        codex: oneOf(CODEX_MODES, saved?.agentModes?.codex, DEFAULT_AGENT_MODES.codex)
      }
    }
  } catch {
    return { completionSoundEnabled: true, steerByDefault: false, agentModes: DEFAULT_AGENT_MODES }
  }
}

export const usePreferences = create<
  Preferences & {
    setCompletionSoundEnabled(enabled: boolean): void
    setSteerByDefault(enabled: boolean): void
    setClaudeMode(mode: ClaudeMode): void
    setCodexMode(mode: CodexMode): void
  }
>((set, get) => {
  function update(patch: Partial<Preferences>) {
    const { completionSoundEnabled, steerByDefault, agentModes } = get()
    const preferences = { completionSoundEnabled, steerByDefault, agentModes, ...patch }
    localStorage.setItem(KEY, JSON.stringify(preferences))
    set(preferences)
  }
  return {
    ...loadPreferences(),
    setCompletionSoundEnabled: (completionSoundEnabled) => update({ completionSoundEnabled }),
    setSteerByDefault: (steerByDefault) => update({ steerByDefault }),
    setClaudeMode: (claude) => update({ agentModes: { ...get().agentModes, claude } }),
    setCodexMode: (codex) => update({ agentModes: { ...get().agentModes, codex } })
  }
})
