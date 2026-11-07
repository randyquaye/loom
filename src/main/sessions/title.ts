/** The model answers with a name only; anything else it says is discarded by cleanTitle. */
export function titleInstruction(prompt: string): string {
  return `Name the following task in at most five words. Reply with the name only: no punctuation, no quotes, no explanation.\n\n${prompt}`
}

const MAX_WORDS = 5
const MAX_CHARS = 48

/**
 * Models wrap names in quotes, fences or trailing punctuation and sometimes add a
 * sentence. Keep the first five words of the first non-empty line and nothing else.
 */
export function cleanTitle(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const line = raw
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '')
  if (line === undefined) return null
  const stripped = line
    .replace(/^[-`>*#\s]+/, '')
    .replace(/[`>*]+$/, '')
    .replace(/^["'“”]+/, '')
    .replace(/["'“”]+$/, '')
    .replace(/[.!?:;,+]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped === '') return null
  const words = stripped.split(' ').slice(0, MAX_WORDS).join(' ')
  return words.length > MAX_CHARS ? `${words.slice(0, MAX_CHARS - 1).trimEnd()}…` : words
}

/** Shown the moment the first prompt is sent, until the model's own name arrives. */
export function excerptTitle(prompt: string): string {
  return cleanTitle(prompt) ?? 'New conversation'
}
