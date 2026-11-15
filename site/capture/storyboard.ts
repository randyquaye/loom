import type { Locator, Page } from '@playwright/test'
import type { AgentEvent } from '../../src/shared/events'
import { SEARCH_CHANGE, SEARCH_TURN } from './fixture'

type Target = (win: Page) => Locator

/**
 * One video command, run `after` ms behind the previous one. Events go to the session the
 * last `send` started; the player stamps their `at` fields at play time.
 */
export type Step = { after: number } & (
  | { kind: 'click'; target: Target }
  | { kind: 'type'; target: Target; text: string }
  /** The app's real send, by Enter in a field or a click on a button; the stand-in agent catches it. */
  | { kind: 'send'; target: Target; by: 'enter' | 'click' }
  | { kind: 'wait'; target: Target }
  | { kind: 'emit'; event: AgentEvent }
  /** Writes a file into the current session's worktree, as the agent's tool would. */
  | { kind: 'write'; file: string; text: string }
  /**
   * Cuts to a new framing in a cropped video. `home` is the crop itself; `action` pans and
   * zooms out just enough to show every target the steps up to the next cut touch.
   */
  | { kind: 'camera'; shot: 'home' | 'action' }
)

const composer: Target = (win) => win.getByPlaceholder('Ask anything…').filter({ visible: true })

/** How long each tool appears to run before its result lands. */
const RUNS: Record<string, number> = { bash: 1200, edit_file: 450, write_file: 450 }
const WRITES = new Set(['edit_file', 'write_file'])

/** SEARCH_TURN typed, sent and played live, so the video and the stills tell one story. */
export function heroStoryboard(): Step[] {
  const turnId = 'hero'
  const { ask, tools, answer } = SEARCH_TURN
  const steps: Step[] = [
    { after: 400, kind: 'type', target: composer, text: ask },
    { after: 300, kind: 'send', target: composer, by: 'enter' },
    { after: 150, kind: 'emit', event: { type: 'turn.started', turnId, at: 0 } }
  ]
  tools.forEach(([name, args, output], i) => {
    const callId = `${turnId}-${i}`
    steps.push({ after: i === 0 ? 1100 : 250, kind: 'emit', event: { type: 'tool.call', turnId, callId, name, args } })
    const run = RUNS[name] ?? 350
    // The file lands just before its result, which is what triggers the Changes refresh.
    const file = (args as { path?: string }).path ?? ''
    const text = SEARCH_CHANGE[file]
    const writes = WRITES.has(name) && text !== undefined
    if (writes) steps.push({ after: run, kind: 'write', file, text })
    const result: AgentEvent = { type: 'tool.result', turnId, callId, ok: true, output }
    steps.push({ after: writes ? 0 : run, kind: 'emit', event: result })
  })
  answer.match(/\S+\s*/g)!.forEach((text, i) => {
    steps.push({ after: i === 0 ? 400 : 30, kind: 'emit', event: { type: 'text.delta', turnId, text } })
  })
  steps.push(
    { after: 100, kind: 'emit', event: { type: 'text.done', turnId, text: answer } },
    { after: 0, kind: 'emit', event: { type: 'turn.done', turnId, stopReason: 'end', at: 0 } }
  )
  return steps
}

/** GitHub's own sample repository: public, tiny and unchanging, so every take matches. */
const REPO_URL = 'https://github.com/octocat/Hello-World'
const PROMPT = 'Add a contributing guide.'
const GUIDE = [
  '# Contributing',
  '',
  '1. Fork the repository and create a branch.',
  '2. Keep each change small and focused.',
  '3. Open a pull request that explains the change.',
  ''
].join('\n')
const COMMENT = 'Ask how the change was tested.'
const FOLLOW_UP = 'Address my review comment.'

/**
 * The full demo behind "See how it works", on the whole window: clone a project and start a
 * task, visit other workspaces while it runs, come back, review its change with a line
 * comment, and ask for a fix.
 */
export function demoStoryboard(): Step[] {
  const [first, second] = ['demo-1', 'demo-2']
  const prompt: Target = (win) => win.getByLabel('What do you want to work on?')
  const workspace =
    (name: string): Target =>
    (win) =>
      win.locator('aside').getByText(name, { exact: true })
  const call = (after: number, turnId: string, callId: string, name: string, args: object): Step => ({
    after,
    kind: 'emit',
    event: { type: 'tool.call', turnId, callId, name, args }
  })
  const result = (after: number, turnId: string, callId: string, output: string): Step => ({
    after,
    kind: 'emit',
    event: { type: 'tool.result', turnId, callId, ok: true, output }
  })
  // Pauses are short: the pointer's travel to each target is the human pace.
  return [
    // A second project, and a task in a new workspace.
    { after: 900, kind: 'click', target: (win) => win.getByRole('button', { name: 'New project' }) },
    { after: 400, kind: 'click', target: (win) => win.getByRole('menuitem', { name: 'Open GitHub project' }) },
    { after: 400, kind: 'type', target: (win) => win.getByPlaceholder('https://github.com/user/repo.git'), text: REPO_URL },
    { after: 200, kind: 'click', target: (win) => win.getByRole('button', { name: /Clone repo/ }) },
    { after: 0, kind: 'wait', target: (win) => win.getByRole('button', { name: 'Project: hello-world' }) },
    { after: 500, kind: 'type', target: prompt, text: PROMPT },
    { after: 300, kind: 'send', target: (win) => win.locator('.nw-modal').getByRole('button', { name: 'Create' }), by: 'click' },
    { after: 150, kind: 'emit', event: { type: 'turn.started', turnId: first, at: 0 } },
    call(1000, first, 'read', 'read_file', { path: 'README' }),
    result(400, first, 'read', 'Hello World!'),
    call(400, first, 'write', 'write_file', { path: 'CONTRIBUTING.md' }),
    { after: 450, kind: 'write', file: 'CONTRIBUTING.md', text: GUIDE },
    result(0, first, 'write', 'Created CONTRIBUTING.md'),
    // Other work while it runs, about two seconds each; it finishes meanwhile.
    { after: 300, kind: 'click', target: workspace('fix-keyboard-navigation') },
    {
      after: 500,
      kind: 'emit',
      event: { type: 'text.done', turnId: first, text: 'Added CONTRIBUTING.md: branch, keep changes small, open a pull request.' }
    },
    { after: 0, kind: 'emit', event: { type: 'turn.done', turnId: first, stopReason: 'end', at: 0 } },
    { after: 1000, kind: 'click', target: workspace('review-the-patch') },
    { after: 1500, kind: 'click', target: workspace('add-contributing-guide') },
    // Review the change, leave a line comment, ask for the fix.
    { after: 1200, kind: 'click', target: (win) => win.getByRole('tab', { name: /Changes/ }) },
    { after: 500, kind: 'click', target: (win) => win.locator('.change-row', { hasText: 'CONTRIBUTING.md' }) },
    { after: 900, kind: 'click', target: (win) => win.getByRole('button', { name: 'Comment on line 5', exact: true }) },
    { after: 300, kind: 'type', target: (win) => win.getByRole('textbox', { name: 'Comment on line 5' }), text: COMMENT },
    { after: 400, kind: 'click', target: (win) => win.locator('.diff-comment-form').getByRole('button', { name: 'Save' }) },
    { after: 800, kind: 'click', target: (win) => win.locator('.session-tab', { hasText: 'New conversation' }) },
    { after: 300, kind: 'type', target: composer, text: FOLLOW_UP },
    { after: 300, kind: 'send', target: composer, by: 'enter' },
    { after: 150, kind: 'emit', event: { type: 'turn.started', turnId: second, at: 0 } },
    call(900, second, 'comments', 'read_file', { path: '.context/attachments/comments.md' })
  ]
}
