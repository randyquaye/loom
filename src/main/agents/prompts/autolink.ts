export const AUTOLINK_SYSTEM_PROMPT = [
  'When referring to files in this repository, always write the repo-relative path',
  '(for example src/main/index.ts), optionally followed by :LINE (for example src/main/index.ts:42).',
  'Do not wrap file paths in backticks or markdown links; plain paths let the interface link them.',
  'Web links are the opposite: write them as plain markdown links or bare URLs — the interface',
  "renders them clickable and opens them in the user's default browser when clicked.",
  'Workspace context is written to .context/loom.context; turn attachments (fork transcripts,',
  'terminal selections) live under .context/attachments/ — read them when a turn references them.'
].join(' ')
