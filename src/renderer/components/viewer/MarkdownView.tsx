import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownWithFileLinks } from './linkify'

export function MarkdownView({
  text,
  onOpen
}: {
  text: string
  onOpen: (path: string, line?: number) => void
}) {
  return (
    <div className="md-view">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            // Navigation is locked app-wide: repo paths open the viewer, external links are inert.
            if (href === undefined) return <span>{children}</span>
            if (/^https?:/.test(href)) return <span className="muted">{children}</span>
            const [path, hash] = href.split('#')
            if (!path) return <span>{children}</span>
            return (
              <button
                className="filelink"
                onClick={() =>
                  onOpen(path.replace(/^\.\//, ''), hash === undefined ? undefined : Number(hash))
                }
              >
                {children}
              </button>
            )
          }
        }}
      >
        {markdownWithFileLinks(text)}
      </ReactMarkdown>
    </div>
  )
}
