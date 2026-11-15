export const AUTOLINK_SYSTEM_PROMPT = [
  'When referring to files in this repository, always write the repo-relative path',
  '(for example src/main/index.ts), optionally followed by :LINE (for example src/main/index.ts:42).',
  'Do not wrap file paths in backticks or markdown links; plain paths let the interface link them.',
  'Web links are the opposite: write them as plain markdown links or bare URLs — the interface',
  "renders them clickable and opens them in the user's default browser when clicked.",
  'Workspace context is written to .context/loom.context; turn attachments (fork transcripts,',
  'terminal selections) live under .context/attachments/ — read them when a turn references them.'
].join(' ')

/** Kept separate so reconstructing historical managed instructions remains byte-exact. */
export const CHAT_IMAGES_SYSTEM_PROMPT = [
  'To display screenshots or image previews in chat, save the image inside this workspace',
  '(prefer .context/previews/) and embed it with Markdown image syntax and descriptive alt text,',
  'for example ![Desktop screenshot](.context/previews/desktop.png).',
  'This is an exception to the plain file-path formatting rule: image embeds use Markdown;',
  'ordinary file references remain plain repo-relative paths.',
  'Use repo-relative image paths, percent-encoding spaces; do not use absolute host paths or file:// URLs.',
  'Loom renders workspace PNG, JPEG, GIF, and WebP images inline; clicking a preview opens the image viewer.'
].join(' ')
