import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { openDb } from '../../src/main/db'
import type { AgentEvent } from '../../src/shared/events'

/** Short neutral root, so any path the app shows reads as demo content. */
export const DEMO_ROOT = '/tmp/loombox-demo'
const REPO = path.join(DEMO_ROOT, 'notes')
const PROFILE = path.join(DEMO_ROOT, 'profile')

// Fixed identity and no user hooks or signing: the demo must never carry the developer's config.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'LoomBox Demo',
  GIT_AUTHOR_EMAIL: 'demo@loombox.invalid',
  GIT_COMMITTER_NAME: 'LoomBox Demo',
  GIT_COMMITTER_EMAIL: 'demo@loombox.invalid'
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'ignore' })
}

const write = (root: string, files: Record<string, string>): void => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
}

const SEARCH_BEFORE = `import type { Note } from './notes'

export function findByTitle(notes: Note[], title: string): Note | undefined {
  return notes.find((note) => note.title === title)
}
`

const SEARCH_ADDITION = `
/** Ranks notes by how many query words appear in the title or body. */
export function searchNotes(notes: Note[], query: string): Note[] {
  const words = query.toLowerCase().split(/\\s+/).filter(Boolean)
  if (words.length === 0) return []
  return notes
    .map((note) => {
      const text = \`\${note.title} \${note.body}\`.toLowerCase()
      return { note, score: words.filter((w) => text.includes(w)).length }
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((hit) => hit.note)
}
`

const SEARCH_TEST = `import { describe, expect, it } from 'vitest'
import { searchNotes } from '../src/search'

const notes = [
  { id: '1', title: 'Release plan', body: 'Ship search on Friday' },
  { id: '2', title: 'Groceries', body: 'Oats, coffee' },
  { id: '3', title: 'Search ideas', body: 'Rank by matching words' }
]

describe('searchNotes', () => {
  it('ranks notes by matching words', () => {
    expect(searchNotes(notes, 'search words').map((n) => n.id)).toEqual(['3', '1'])
  })
  it('ignores case', () => expect(searchNotes(notes, 'GROCERIES')).toHaveLength(1))
  it('returns nothing for an empty query', () => expect(searchNotes(notes, '  ')).toEqual([]))
})
`

/** Builds the demo repo: one commit on main, then a real worktree per workspace. */
function buildRepo(slugs: string[]): void {
  write(REPO, {
    'README.md': '# notes\n\nA small command-line notes app.\n',
    'package.json': JSON.stringify(
      { name: 'notes', type: 'module', scripts: { test: 'vitest run' } },
      null,
      2
    ),
    'src/notes.ts': 'export type Note = { id: string; title: string; body: string }\n',
    'src/search.ts': SEARCH_BEFORE,
    'src/keyboard.ts': "export const keys = { next: 'j', previous: 'k', open: 'Enter' }\n"
  })
  git(REPO, 'init', '-q', '-b', 'main')
  git(REPO, 'add', '.')
  git(REPO, 'commit', '-q', '-m', 'Initial notes app')
  for (const slug of slugs) {
    git(REPO, 'worktree', 'add', '-q', '-b', `loombox/${slug}`, path.join(DEMO_ROOT, 'workspaces', slug))
  }
  // The uncommitted work the Changes view shows: one modified file, one new test.
  write(path.join(DEMO_ROOT, 'workspaces', 'add-project-search'), {
    'src/search.ts': SEARCH_BEFORE + SEARCH_ADDITION,
    'test/search.test.ts': SEARCH_TEST
  })
  // Intent-to-add, so the new test lists by name rather than as an untracked folder.
  git(path.join(DEMO_ROOT, 'workspaces', 'add-project-search'), 'add', '-N', 'test/search.test.ts')
}

type Turn = { ask: string; tools: Array<[name: string, args: object, output: string]>; answer: string }

function turnEvents(id: string, turn: Turn, endAt: number): AgentEvent[] {
  const events: AgentEvent[] = [{ type: 'user.text', turnId: `${id}-user`, text: turn.ask }]
  turn.tools.forEach(([name, args, output], i) => {
    events.push({ type: 'tool.call', turnId: id, callId: `${id}-${i}`, name, args })
    events.push({ type: 'tool.result', turnId: id, callId: `${id}-${i}`, ok: true, output })
  })
  events.push({ type: 'text.done', turnId: id, text: turn.answer })
  events.push({ type: 'turn.done', turnId: id, stopReason: 'end', at: endAt })
  return events
}

const SEARCH_TURN: Turn = {
  ask: 'Add project search: match notes by title and body, best matches first. Add tests.',
  tools: [
    ['read_file', { path: 'src/search.ts' }, SEARCH_BEFORE],
    ['grep', { pattern: 'findByTitle', path: 'src' }, 'src/search.ts:3'],
    ['edit_file', { path: 'src/search.ts' }, 'Edited src/search.ts'],
    ['write_file', { path: 'test/search.test.ts' }, 'Created test/search.test.ts'],
    ['bash', { command: 'pnpm test' }, '✓ test/search.test.ts (3 tests)\n\nTests  3 passed (3)']
  ],
  answer: [
    'Added `searchNotes` to src/search.ts.',
    '',
    '- Matches every query word against title and body, ignoring case.',
    '- Ranks notes by how many words match; ties keep their order.',
    '- An empty query returns no results.',
    '',
    'Three tests in test/search.test.ts cover ranking, case and empty queries. All pass.'
  ].join('\n')
}

/** A one-tool turn, for sessions that only need to exist in lists. */
const brief = (ask: string, tool: [string, object, string], answer: string): Turn => ({
  ask,
  tools: [tool],
  answer
})

type Session = {
  ws: string
  id: string
  agent: 'claude' | 'codex'
  title: string
  ago: number
  turn: Turn
  closed?: true
}
const MODELS = { claude: 'claude-opus-5-5', codex: 'gpt-6.1-sol' }

const SESSIONS: Session[] = [
  {
    ws: 'add-project-search',
    id: 's-search',
    agent: 'claude',
    title: 'Add project search',
    ago: 40,
    turn: SEARCH_TURN
  },
  {
    ws: 'add-project-search',
    id: 's-ranking',
    agent: 'codex',
    title: 'Review search ranking',
    ago: 25,
    turn: brief(
      'Review the ranking in searchNotes for edge cases.',
      ['read_file', { path: 'src/search.ts' }, '…'],
      'Ranking is stable for ties. Consider weighting title matches above body matches.'
    )
  },
  {
    ws: 'add-project-search',
    id: 's-plan',
    agent: 'claude',
    title: 'Plan the search results view',
    ago: 220,
    closed: true,
    turn: brief(
      'Sketch how search results should look in the list.',
      ['read_file', { path: 'src/notes.ts' }, '…'],
      'Show the title, then the first matching line of the body.'
    )
  },
  {
    ws: 'add-project-search',
    id: 's-highlight',
    agent: 'codex',
    title: 'Highlight matching words',
    ago: 180,
    closed: true,
    turn: brief(
      'How would we highlight the matched words?',
      ['grep', { pattern: 'title', path: 'src' }, 'src/notes.ts:1'],
      'Return match ranges from searchNotes and let the view wrap them.'
    )
  },
  {
    ws: 'fix-keyboard-navigation',
    id: 's-keys',
    agent: 'codex',
    title: 'Fix keyboard navigation',
    ago: 90,
    turn: brief(
      'Arrow keys should move between notes, not just j and k.',
      ['edit_file', { path: 'src/keyboard.ts' }, 'Edited src/keyboard.ts'],
      'Arrow keys now mirror j and k. Enter still opens the selected note.'
    )
  },
  {
    ws: 'review-the-patch',
    id: 's-review',
    agent: 'claude',
    title: 'Review the patch',
    ago: 150,
    turn: brief(
      'Review the open patch before it merges.',
      ['bash', { command: 'git diff main' }, '2 files changed'],
      'The patch is small and covered by tests. One naming nit in src/notes.ts.'
    )
  }
]

/** Recreates the demo from scratch and returns the profile directory for LOOM_DATA_DIR. */
export function buildFixture(): string {
  rmSync(DEMO_ROOT, { recursive: true, force: true })
  const slugs = [...new Set(SESSIONS.map((s) => s.ws))]
  buildRepo(slugs)
  mkdirSync(PROFILE, { recursive: true })
  const db = openDb(path.join(PROFILE, 'loom.db'))
  const now = Date.now()
  const minutesAgo = (m: number): number => now - m * 60_000
  db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run(
    'p',
    'notes',
    REPO,
    minutesAgo(600)
  )
  const addWorkspace = db.prepare(
    'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at, auto_named) VALUES (?, ?, ?, ?, ?, ?, 0)'
  )
  slugs.forEach((slug, i) => {
    addWorkspace.run(
      slug,
      'p',
      slug,
      `loombox/${slug}`,
      path.join(DEMO_ROOT, 'workspaces', slug),
      minutesAgo(300 - i)
    )
  })
  const addSession = db.prepare(
    `INSERT INTO sessions (id, workspace_id, backend, model, effort, title, created_at, closed_at, last_read_seq)
     VALUES (?, ?, ?, ?, 'high', ?, ?, ?, ?)`
  )
  const addEvent = db.prepare(
    'INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)'
  )
  for (const s of SESSIONS) {
    const events = turnEvents(s.id, s.turn, minutesAgo(s.ago))
    const closedAt = s.closed ? minutesAgo(s.ago - 2) : null
    addSession.run(
      s.id,
      s.ws,
      s.agent,
      MODELS[s.agent],
      s.title,
      minutesAgo(s.ago + 5),
      closedAt,
      events.length
    )
    events.forEach((event, i) =>
      addEvent.run(s.id, i + 1, minutesAgo(s.ago) - 1000 + i, event.type, JSON.stringify(event))
    )
  }
  db.close()
  return PROFILE
}
