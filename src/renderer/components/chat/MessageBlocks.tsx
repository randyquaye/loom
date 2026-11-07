import { useEffect, useState, type ReactNode } from 'react'
import type { FilePatch } from '../../../shared/events'
import { renderWithFileLinks } from '../viewer/linkify'
import { ChatMarkdown } from './ChatMarkdown'
import {
  firstLine,
  formatDuration,
  groupLabel,
  toolSummary,
  type AssistantTurn,
  type SubagentBlock,
  type ToolBlock,
  type ToolKind
} from './transcript'
import './chat.css'

type FileOpen = (path: string, line?: number) => void

/* ---------- icons (16px, stroke = currentColor) ---------- */

function Svg({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={`chat-icon${className === undefined ? '' : ` ${className}`}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const TOOL_GLYPHS: Record<ToolKind, ReactNode> = {
  bash: <path d="M2.5 4.5 6 8l-3.5 3.5M8 12h5.5" />,
  grep: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3.25 3.25" />
    </>
  ),
  glob: (
    <>
      <path d="M2 4.5h4l1.5 1.5H14v7.5H2z" />
      <circle cx="8.5" cy="9.5" r="1.75" />
      <path d="m9.75 10.75 1.5 1.5" />
    </>
  ),
  read: (
    <>
      <path d="M4 1.75h5.5L12.5 4.75v9.5H4z" />
      <circle cx="8" cy="9" r="1.75" />
      <path d="m9.25 10.25 1.25 1.25" />
    </>
  ),
  write: (
    <>
      <path d="M4 1.75h5.5L12.5 4.75v9.5H4z" />
      <path d="M8.25 7.5v4M6.25 9.5h4" />
    </>
  ),
  edit: <path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" />,
  other: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.5v5M5.5 8h5" />
    </>
  )
}

export function ToolIcon({ kind }: { kind: ToolKind }) {
  return <Svg>{TOOL_GLYPHS[kind]}</Svg>
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <Svg className={`chat-chevron${open ? ' is-open' : ''}`}>
      <path d="m6 4 4 4-4 4" />
    </Svg>
  )
}

function ErrorIcon() {
  return (
    <Svg>
      <circle cx="8" cy="8" r="6" />
      <path d="m5.75 5.75 4.5 4.5m0-4.5-4.5 4.5" />
    </Svg>
  )
}

function CopyIcon() {
  return (
    <Svg>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.75" />
      <path d="M10.75 5.25V3.5a1.25 1.25 0 0 0-1.25-1.25H3.5A1.25 1.25 0 0 0 2.25 3.5v6c0 .7.55 1.25 1.25 1.25h1.75" />
    </Svg>
  )
}

function CheckIcon() {
  return (
    <Svg>
      <path d="m3.5 8.5 3 3 6-7" />
    </Svg>
  )
}

function Spinner() {
  return <span className="chat-spinner" role="status" aria-label="Running" />
}

/* ---------- prose ---------- */

export function UserBubble({ text, onFileOpen }: { text: string; onFileOpen: FileOpen | undefined }) {
  return (
    <div className="chat-user">{onFileOpen === undefined ? text : renderWithFileLinks(text, onFileOpen)}</div>
  )
}

export function AssistantText({
  text,
  streaming,
  onFileOpen
}: {
  text: string
  streaming: boolean
  onFileOpen: FileOpen | undefined
}) {
  return <ChatMarkdown text={text} streaming={streaming} onFileOpen={onFileOpen} />
}

export function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="chat-reasoning">
      <button
        type="button"
        className="chat-row chat-row-toggle chat-reasoning-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronIcon open={open} />
        <span className="chat-row-label">Reasoning</span>
      </button>
      {open && <div className="chat-reasoning-text chat-reveal">{text}</div>}
    </div>
  )
}

/* ---------- tool + error rows ---------- */

export function ErrorRow({ message, code }: { message: string; code?: string | undefined }) {
  const line = firstLine(message) || message
  return (
    <div className="chat-row chat-error-row" role="alert" title={message}>
      <span className="chat-row-icon">
        <ErrorIcon />
      </span>
      <span className="chat-row-label">Error</span>
      {line !== '' && <code className="chat-chip chat-chip-danger">{line}</code>}
      {code !== undefined && <span className="chat-row-suffix">{code}</span>}
    </div>
  )
}

export function ToolRow({
  block,
  patches,
  live
}: {
  block: ToolBlock
  patches: FilePatch[] | undefined
  /** The turn is still running, so an unresolved call shows a spinner. */
  live: boolean
}) {
  const [open, setOpen] = useState(false)
  const summary = toolSummary(block)
  const pending = block.ok === undefined && live
  const hasPatches = patches !== undefined && patches.length > 0
  const hasOutput = block.output !== undefined && block.output.trim() !== ''
  const expandable = hasPatches || hasOutput
  const state = block.ok === undefined ? (live ? 'pending' : 'unknown') : block.ok ? 'ok' : 'fail'

  const content = (
    <>
      <span className="chat-row-icon" title={state}>
        {pending ? <Spinner /> : <ToolIcon kind={summary.kind} />}
      </span>
      <span className="chat-row-label">{summary.label}</span>
      {summary.target !== undefined && (
        <>
          <span className="chat-row-in">in</span>
          <span className="chat-row-target">{summary.target}</span>
        </>
      )}
      {summary.chip !== undefined && <code className="chat-chip">{summary.chip}</code>}
      {summary.suffix !== undefined && <span className="chat-row-suffix">{summary.suffix}</span>}
      {block.ok === true && (
        <span className="chat-tool-ok" role="img" aria-label="Succeeded">
          <CheckIcon />
        </span>
      )}
    </>
  )

  return (
    <div className="chat-tool" data-state={state}>
      {expandable ? (
        <button
          type="button"
          className="chat-row chat-row-toggle"
          aria-expanded={open}
          title={[summary.label, summary.target, summary.chip, summary.suffix].filter(Boolean).join(' ')}
          onClick={() => setOpen(!open)}
        >
          {content}
        </button>
      ) : (
        <div
          className="chat-row"
          title={[summary.label, summary.target, summary.chip].filter(Boolean).join(' ')}
        >
          {content}
        </div>
      )}
      {block.ok === false && <ErrorRow message={block.output ?? ''} />}
      {open && expandable && (
        <div className="chat-tool-detail chat-reveal">
          {hasPatches && patches.map((patch, i) => <PatchView key={`${patch.path}-${i}`} patch={patch} />)}
          {hasOutput && (!hasPatches || block.ok === false) && (
            <pre className="chat-output">{block.output}</pre>
          )}
        </div>
      )}
    </div>
  )
}

/** Running numbers for the header, omitting whatever the adapter has not reported. */
function subagentProgress(block: SubagentBlock): string {
  const parts: string[] = []
  if (block.tokens !== undefined) parts.push(`${block.tokens.toLocaleString('en-US')} tok`)
  if (block.toolUses !== undefined) parts.push(`${block.toolUses} tool${block.toolUses === 1 ? '' : 's'}`)
  if (block.lastTool !== undefined) parts.push(`last: ${block.lastTool}`)
  if (block.durationMs !== undefined) parts.push(formatDuration(block.durationMs))
  return parts.join(' · ')
}

/** A spawned subagent: collapsed header with live numbers, expandable to its brief and report. */
export function SubagentRow({
  block,
  live,
  onFileOpen
}: {
  block: SubagentBlock
  /** The turn is still running, so an unended subagent shows a spinner. */
  live: boolean
  onFileOpen: FileOpen | undefined
}) {
  const [open, setOpen] = useState(false)
  const ended = block.ok !== undefined
  const running = !ended && live
  const state = ended ? (block.ok ? 'ok' : 'fail') : live ? 'pending' : 'unknown'
  const progress = ended ? '' : subagentProgress(block)
  const hasReport = block.report !== undefined && block.report.trim() !== ''
  const expandable = block.prompt !== undefined || hasReport || ended

  const content = (
    <>
      {expandable && <ChevronIcon open={open} />}
      <span className="chat-row-icon" title={state}>
        {running ? (
          <Spinner />
        ) : (
          <span className="chat-subagent-glyph" aria-hidden="true">
            ⌬
          </span>
        )}
      </span>
      <span className="chat-row-label">{block.description}</span>
      {block.subagentType !== undefined && <span className="chat-subagent-badge">{block.subagentType}</span>}
      {block.depth !== undefined && block.depth > 1 && (
        <span className="chat-subagent-badge">nested ×{block.depth}</span>
      )}
      {block.backgrounded === true && <span className="chat-subagent-badge">background</span>}
      {progress !== '' && <span className="chat-row-suffix">{progress}</span>}
      {ended && (
        <code className={`chat-chip ${block.ok ? 'chat-chip-ok' : 'chat-chip-danger'}`}>
          {block.ok ? 'done' : 'failed'}
        </code>
      )}
      {ended && block.durationMs !== undefined && (
        <span className="chat-row-suffix">{formatDuration(block.durationMs)}</span>
      )}
    </>
  )

  return (
    <div className="chat-subagent" data-state={state}>
      {expandable ? (
        <button
          type="button"
          className="chat-row chat-row-toggle chat-subagent-head"
          aria-expanded={open}
          title={block.description}
          onClick={() => setOpen(!open)}
        >
          {content}
        </button>
      ) : (
        <div className="chat-row chat-subagent-head" title={block.description}>
          {content}
        </div>
      )}
      {open && expandable && (
        <div className="chat-subagent-body chat-reveal">
          {block.prompt !== undefined && (
            <>
              <span className="chat-subagent-caption">Brief</span>
              <pre className="chat-output chat-subagent-brief">{block.prompt}</pre>
            </>
          )}
          {hasReport ? (
            <ChatMarkdown text={block.report ?? ''} onFileOpen={onFileOpen} />
          ) : (
            ended && <span className="chat-subagent-empty">No report returned.</span>
          )}
        </div>
      )}
    </div>
  )
}

function lineKind(line: string): 'add' | 'del' | 'ctx' {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'add'
  if (line.startsWith('-') && !line.startsWith('---')) return 'del'
  return 'ctx'
}

const GUTTER = { add: '+', del: '−', ctx: ' ' } as const

export function PatchView({ patch }: { patch: FilePatch }) {
  const lines = patch.diff.split('\n').filter((line) => line !== '')
  return (
    <div className="chat-patch">
      <div className="chat-patch-head">
        <span>{patch.kind}</span>
        <span className="grow">{patch.path}</span>
      </div>
      <div className="chat-patch-lines">
        {lines.map((line, i) => {
          const kind = lineKind(line)
          return (
            <div key={i} className="chat-patch-line" data-kind={kind}>
              <span className="chat-patch-gutter">{GUTTER[kind]}</span>
              <span>{kind === 'ctx' ? line : line.slice(1)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ---------- turn chrome ---------- */

export function TurnGroupHeader({
  turn,
  open,
  onToggle
}: {
  turn: AssistantTurn
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="chat-row chat-row-toggle chat-group-head"
      aria-expanded={open}
      onClick={onToggle}
    >
      <ChevronIcon open={open} />
      <span className="chat-row-label">{groupLabel(turn)}</span>
      <span className="chat-group-kinds">
        {turn.toolKinds.map((kind) => (
          <ToolIcon key={kind} kind={kind} />
        ))}
      </span>
    </button>
  )
}

export function TurnMeta({ label, copyText }: { label: string | undefined; copyText: string | undefined }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  if (label === undefined && copyText === undefined) return null
  return (
    <div className="chat-meta">
      {label !== undefined && <span>{label}</span>}
      {copyText !== undefined && (
        <button
          type="button"
          className="chat-icon-btn"
          title={copied ? 'Copied' : 'Copy text'}
          aria-label={copied ? 'Copied' : 'Copy text'}
          onClick={() => {
            void navigator.clipboard
              .writeText(copyText)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      )}
    </div>
  )
}

export function ThinkingRow({ since }: { since: number | undefined }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const elapsed = since === undefined ? undefined : Math.max(0, Math.floor((now - since) / 1000))
  return (
    <div className="chat-row chat-thinking" role="status">
      <span className="chat-row-icon">
        <span className="chat-pulse" aria-hidden="true" />
      </span>
      <span className="chat-row-label">Thinking…</span>
      {elapsed !== undefined && <span className="chat-row-suffix">{elapsed}s</span>}
    </div>
  )
}
