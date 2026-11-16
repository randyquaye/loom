import type { ReactNode } from 'react'

export const PATH_RE =
  /(?<![\w./-])((?:\.\/)?(?:\.context\/(?:[\w.-]+\/)*[\w.-]*[\w-]|[\w.-]+(?:\/[\w.-]+)*\.(?:md|json|[cm]?[jt]sx?|ya?ml|sh|py|tfvars|tf|hcl|toml|txt|log|html?|css|csv|svg|png|jpe?g|gif|webp)))(?::(\d+))?(?![\w/-]|:\d|\.(?=[\w.-]))/g

/** Turns repo-relative path mentions (with optional :line) into clickable chips. */
export function renderWithFileLinks(
  text: string,
  onOpen: (path: string, line?: number) => void
): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  const re = new RegExp(PATH_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const path = match[1] as string
    const line = match[2] === undefined ? undefined : Number(match[2])
    out.push(
      <button
        key={`f${key++}`}
        className="filelink"
        title={`Open ${path}${line === undefined ? '' : `:${line}`}`}
        onClick={() => onOpen(path, line)}
      >
        {match[0]}
      </button>
    )
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
