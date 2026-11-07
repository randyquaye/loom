/** The main-process contract for workspace names (also the git branch/worktree slug). */
export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
const MAX_LEN = 41

/** Filler words that carry no meaning in a name ("please fix the login bug" -> fix-login-bug). */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'can',
  'could',
  'for',
  'i',
  'in',
  'is',
  'it',
  'let',
  'lets',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'please',
  'should',
  'so',
  'that',
  'the',
  'this',
  'to',
  'us',
  'we',
  'with',
  'would',
  'you'
])

function trimTo(slug: string, max: number): string {
  return slug.slice(0, max).replace(/-+$/, '')
}

/**
 * Derives a workspace name from the first prompt, locally and deterministically: no model
 * call, so creating a workspace never waits on (or pays for) a provider. Takes the first four
 * or fewer significant words (stop words dropped, unless that leaves nothing), lowercases and
 * slugifies them to WORKSPACE_NAME, and suffixes -2, -3… when the project already has the name.
 */
export function workspaceNameFromPrompt(prompt: string, taken: readonly string[]): string {
  const words = prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '')
  const significant = words.filter((w) => !STOP_WORDS.has(w))
  const picked = significant.length > 0 ? significant : words
  const base = trimTo(picked.slice(0, 4).join('-'), MAX_LEN) || 'workspace'
  let name = base
  for (let n = 2; taken.includes(name); n++) {
    const suffix = `-${n}`
    name = `${trimTo(base, MAX_LEN - suffix.length)}${suffix}`
  }
  return name
}
