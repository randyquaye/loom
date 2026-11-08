export interface SttState {
  /** Provisional text for the segment currently being recognized. */
  live: string
  /** Finalized segments, in order; the utterance is their join. */
  committed: string[]
  error: string | null
}

export const STT_INITIAL: SttState = { live: '', committed: [], error: null }

/** armed: hands-free mic open, nothing heard yet; capturing: words are arriving. */
export type TalkPhase = 'idle' | 'armed' | 'capturing' | 'finalizing'

/** Pure fold over the Scribe realtime wire messages; unknown types are ignored, not fatal. */
export function applySttMessage(state: SttState, message: unknown): SttState {
  if (typeof message !== 'object' || message === null) return state
  const msg = message as Record<string, unknown>
  const text = typeof msg.text === 'string' ? msg.text : undefined
  switch (msg.message_type) {
    case 'partial_transcript':
      return { ...state, live: text ?? '' }
    case 'committed_transcript':
    case 'committed_transcript_with_timestamps':
      if (text === undefined || text.trim() === '') return { ...state, live: '' }
      return { ...state, live: '', committed: [...state.committed, text.trim()] }
    case 'session_started':
    case 'warning':
      return state
    default:
      // Every Scribe error type carries { message_type, error }.
      return typeof msg.error === 'string' ? { ...state, error: msg.error } : state
  }
}

/** Committed segments plus any uncommitted live tail, as one utterance. */
export function utteranceOf(state: SttState): string {
  const parts = state.live.trim() === '' ? state.committed : [...state.committed, state.live.trim()]
  return parts.join(' ').trim()
}

/**
 * Release-to-send handoff: a clean composer submits the utterance once through the existing
 * delivery behavior (Send-now semantics when a turn is running); any existing draft or
 * attachment is preserved by appending the utterance for review instead of consuming it.
 */
export function talkHandoff(
  draft: string,
  attachmentCount: number,
  running: boolean
): { kind: 'submit'; interrupt: boolean } | { kind: 'append' } {
  if (draft.trim() !== '' || attachmentCount > 0) return { kind: 'append' }
  return { kind: 'submit', interrupt: running }
}
