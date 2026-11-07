import { isValidElement, memo, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeFence } from './CodeFence'
import { PATH_RE } from '../viewer/linkify'

type FileOpen = (path: string, line?: number) => void

const OPEN = 'loom:open/'

interface MarkdownNode {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

/** Link prose after parsing, so all fence lengths, code spans and reference links stay intact. */
function linkFilePaths() {
  const visit = (node: MarkdownNode): void => {
    if (['link', 'linkReference', 'image', 'imageReference', 'code', 'inlineCode'].includes(node.type)) return
    if (node.children === undefined) return
    node.children = node.children.flatMap((child) => {
      if (child.type !== 'text' || child.value === undefined) {
        visit(child)
        return [child]
      }
      const text = child.value
      // The boundary also prevents the shared regex's `ts` alternative from consuming half of `.tsx`.
      const re = new RegExp(`${PATH_RE.source}(?![\\w./-]|:\\d)`, 'g')
      const nodes: MarkdownNode[] = []
      let end = 0
      for (const match of text.matchAll(re)) {
        if (match.index > end) nodes.push({ type: 'text', value: text.slice(end, match.index) })
        const path = match[1] as string
        const line = match[2]
        nodes.push({
          type: 'link',
          url: `${OPEN}${encodeURIComponent(path)}${line === undefined ? '' : `#${line}`}`,
          children: [{ type: 'text', value: match[0] }]
        })
        end = match.index + match[0].length
      }
      if (end < text.length) nodes.push({ type: 'text', value: text.slice(end) })
      return nodes
    })
  }
  return visit
}

function parseTarget(href: string): { path: string; line: number | undefined } | undefined {
  const raw = href.startsWith(OPEN) ? href.slice(OPEN.length) : href
  const [pathPart, hash] = raw.split('#')
  let path: string
  try {
    path = decodeURIComponent(pathPart ?? '').replace(/^\.\//, '')
  } catch {
    return undefined
  }
  if (path === '') return undefined
  const line = hash !== undefined && /^L?\d+$/.test(hash) ? Number(hash.replace(/^L/, '')) : undefined
  return { path, line }
}

function urlTransform(url: string): string {
  return url.startsWith(OPEN) ? url : defaultUrlTransform(url)
}

/** A fenced block reaches us as a <pre> wrapping one <code>; pull language and text back out. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

function components(onFileOpen: FileOpen | undefined, streaming: boolean): Components {
  return {
    a: ({ href, children }) => {
      // Navigation is locked app-wide: repo paths open the viewer; web links leave through
      // the OS default browser on an explicit click; every other scheme stays inert text.
      if (href === undefined || href === '') return <span>{children}</span>
      if (/^https?:\/\//i.test(href)) {
        return (
          <button
            type="button"
            className="chat-weblink"
            title={`Open in your browser: ${href}`}
            onClick={() => void window.loom.shell.openExternal(href)}
          >
            {children}
          </button>
        )
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith(OPEN)) {
        return (
          <span className="chat-md-link" title={href}>
            {children}
          </span>
        )
      }
      const target = parseTarget(href)
      if (target === undefined || onFileOpen === undefined) {
        return <span className="chat-md-link">{children}</span>
      }
      return (
        <button
          type="button"
          className="filelink chat-filelink"
          title={`Open ${target.path}${target.line === undefined ? '' : `:${target.line}`}`}
          onClick={() => onFileOpen(target.path, target.line)}
        >
          {children}
        </button>
      )
    },
    table: ({ children }) => (
      <div className="chat-md-table">
        <table>{children}</table>
      </div>
    ),
    input: ({ checked }) => (
      <span
        className="chat-task-check"
        data-checked={checked === true ? 'true' : undefined}
        role="img"
        aria-label={checked === true ? 'Completed' : 'Incomplete'}
      >
        {checked === true ? '✓' : ''}
      </span>
    ),
    pre: ({ children }) => {
      const child = Array.isArray(children) ? children[0] : children
      const props = isValidElement<{ className?: string; children?: ReactNode }>(child) ? child.props : null
      const lang =
        props?.className === undefined ? null : (/language-([\w-]+)/.exec(props.className)?.[1] ?? null)
      return (
        <CodeFence lang={lang} code={props === null ? '' : textOf(props.children)} streaming={streaming} />
      )
    }
  }
}

/** Assistant prose: GitHub-flavored Markdown, flat at full column width. */
export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  streaming,
  onFileOpen
}: {
  text: string
  streaming?: boolean
  onFileOpen: FileOpen | undefined
}) {
  return (
    <div className="chat-md" data-streaming={streaming === true ? 'true' : undefined}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, linkFilePaths]}
        urlTransform={urlTransform}
        components={components(onFileOpen, streaming === true)}
      >
        {text}
      </ReactMarkdown>
      {streaming === true && <span className="chat-caret" aria-hidden="true" />}
    </div>
  )
})
