/** Essential operating rules supplied directly to every Loom agent session. */
export const LOOM_WORKSPACE_RULES = [
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
