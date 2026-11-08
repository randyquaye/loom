/**
 * Prose and list text speak; fenced blocks and blockquotes are skipped. List markers
 * are stripped before sentence segmentation. Text becomes speech at sentence boundaries
 * ([.!?] followed by whitespace) or at line ends, holding an incomplete fragment until
 * more text arrives or the turn ends.
 */
export interface SpeechCursor {
  inFence: boolean
  /** Unspoken raw prefix: a held sentence fragment or an unfinished line. */
  held: string
}

export const SPEECH_CURSOR_START: SpeechCursor = { inFence: false, held: '' }

const LIST_LINE = /^\s*(?:[-+*•]|\d+[.)])\s+/
const SENTENCE_END = /(?<=[.!?])\s+/

function proseLine(line: string): string | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('>')) return null
  return trimmed.replace(LIST_LINE, '')
}

function sentences(text: string): string[] {
  return text
    .split(SENTENCE_END)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

export function extractSpeech(
  chunk: string,
  cursor: SpeechCursor
): { speech: string[]; cursor: SpeechCursor } {
  const speech: string[] = []
  let { inFence, held } = cursor
  const lines = (held + chunk).split('\n')
  held = lines.pop() ?? ''
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const prose = proseLine(line)
    if (prose === null) continue
    speech.push(...sentences(prose))
  }
  // Mid-line sentence boundaries inside the held fragment speak immediately.
  const parts = held.replace(LIST_LINE, '').split(SENTENCE_END)
  if (parts.length > 1) {
    held = parts.pop() ?? ''
    for (const part of parts) {
      const prose = proseLine(part)
      if (prose !== null && !inFence) speech.push(...sentences(prose))
    }
  }
  return { speech, cursor: { inFence, held } }
}

/** Turn end: whatever fragment is held speaks too, even without terminal punctuation. */
export function flushSpeech(cursor: SpeechCursor): { speech: string[]; cursor: SpeechCursor } {
  const prose = cursor.inFence ? null : proseLine(cursor.held)
  return { speech: prose === null ? [] : sentences(prose), cursor: SPEECH_CURSOR_START }
}
