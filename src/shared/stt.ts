export interface SttState {
  /** Provisional text for the segment currently being recognized. */
  live: string
  /** Finalized segments, in order; the utterance is their join. */
  committed: string[]
  error: string | null
}

export const STT_INITIAL: SttState = { live: '', committed: [], error: null }

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
