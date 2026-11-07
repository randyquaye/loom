import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Operator facts shared by the bundled Claude skill and the codex AGENTS.md
 * seed. Keep short: both land inside every session's context.
 */
export const SKILL_FACTS = [
  '## Loom workspace facts',
  '',
  '- This checkout is one Loom workspace: a git worktree on branch `loom/<slug>`;',
  '  other workspaces of the same repository run in parallel elsewhere. Never',
  '  switch branches, reset --hard, or touch refs/loom/* yourself.',
  '- `.context/` is git-excluded scratch space: `loom.context` holds workspace',
  '  facts (name, branch, repository, agent, port); `attachments/` holds turn',
  '  attachments (fork transcripts, terminal selections). Read them when a turn',
  '  references them; write notes there, never into tracked files unasked.',
  '- Loom auto-saves a worktree checkpoint before every user turn',
  '  (private refs under `refs/loom/checkpoints/`). Undo happens through the',
  '  app UI; do not attempt manual restores.',
  '- Environment: LOOM_WORKSPACE_NAME, LOOM_WORKSPACE_ID, LOOM_WORKSPACE_PATH,',
  '  LOOM_ROOT_PATH, LOOM_DEFAULT_BRANCH, LOOM_PORT (ten-port block starting',
  '  there), LOOM_IS_LOCAL=1. Use $LOOM_PORT for dev servers.',
  '- Repository settings live in `.loom/settings.toml`: `scripts.setup` ran at',
  '  workspace creation; `scripts.run.<id>` are user-triggered actions. Do not',
  '  edit it unless asked.',
  '- Etiquette: reference files as repo-relative paths with optional :LINE;',
  '  do not post to external services or open network mutations unless the user',
  '  explicitly asks; do not commit unless asked.'
].join('\n')

export const LOOM_SKILL_MD = `---
name: loom
description: Operate inside a Loom workspace — worktrees, .context scratch, checkpoints, ports, repo settings and review etiquette. Always relevant in Loom sessions.
---

# Loom

Loom coordinates parallel coding agents, each in an isolated git worktree.
This skill carries the facts that are easy to get wrong from inside a session.

${SKILL_FACTS}
`

/**
 * Writes the bundled skill as a Claude-plugin-shaped directory under the data
 * root so claude sessions can load it with --plugin-dir. Returns the dir.
 */
export async function materializeLoomSkill(dataRoot: string): Promise<string> {
  const dir = path.join(dataRoot, 'loom-skill')
  await mkdir(path.join(dir, '.claude-plugin'), { recursive: true })
  await mkdir(path.join(dir, 'skills', 'loom'), { recursive: true })
  await writeFile(path.join(dir, '.claude-plugin', 'plugin.json'), '{ "name": "loom" }\n', 'utf8')
  await writeFile(path.join(dir, 'skills', 'loom', 'SKILL.md'), LOOM_SKILL_MD, 'utf8')
  return dir
}
