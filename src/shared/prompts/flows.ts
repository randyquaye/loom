/**
 * Built-in flow prompts for the composer quick actions (W5). A project's
 * custom_prompt_* column overrides the matching template when set; the
 * renderer appends the live worktree context (Changes diffs, diagnostics)
 * after the template text.
 */
export const REVIEW_DIFF_PROMPT = [
  'Review the uncommitted changes in this worktree like a careful reviewer:',
  'correctness first, then security, then clarity and naming.',
  'Reference files with repo-relative paths and line numbers.',
  'Do not modify any files; finish with a short ranked list of findings,',
  'each one line, most severe first.'
].join(' ')

export const FIX_ERRORS_PROMPT = [
  'The diagnostics block below reports errors in this worktree.',
  'Fix each one at its source rather than suppressing it, re-check after editing,',
  'and finish with a one-line summary per fix.',
  'Reference files with repo-relative paths and line numbers.'
].join(' ')
