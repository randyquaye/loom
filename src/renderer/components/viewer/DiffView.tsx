import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { CommentRow } from '../../../shared/ipc-contract'
import { cacheKey, useFiles } from '../../state/files'
import { useProjects } from '../../state/projects'
import { useToasts } from '../ui/Toast'
import '../panels/panels.css'

type RowKind = 'add' | 'del' | 'hunk' | 'header' | 'note' | 'ctx'

/** Git quotes paths containing control characters and UTF-8 octal byte escapes. */
function newSidePath(header: string): string | null {
  let path = header.slice(4)
  if (path.startsWith('"')) {
    if (!path.endsWith('"')) return null
    const encoder = new TextEncoder()
    const escapes: Record<string, string> = {
      a: '\u0007',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\u000b',
      '"': '"',
      '\\': '\\'
    }
    const bytes: number[] = []
    for (const part of path.slice(1, -1).match(/\\[0-7]{1,3}|\\.|[^\\]+/g) ?? []) {
      if (/^\\[0-7]{1,3}$/.test(part)) bytes.push(parseInt(part.slice(1), 8))
      else
        bytes.push(
          ...encoder.encode(part.startsWith('\\') ? (escapes[part.slice(1)] ?? part.slice(1)) : part)
        )
    }
    path = new TextDecoder().decode(Uint8Array.from(bytes))
  }
  return path.startsWith('b/') ? path.slice(2) : null
}

function diffRows(
  diff: string
): { text: string; kind: RowKind; newLine: number | null; path: string | null }[] {
  let inHunk = false
  let nextLine: number | null = null
  let newFile = false
  let path: string | null = null
  return diff
    .replace(/\n$/, '')
    .split(/\r?\n/)
    .map((line) => {
      let kind: RowKind = 'ctx'
      let newLine: number | null = null
      if (line.startsWith('diff --git ')) {
        inHunk = false
        nextLine = null
        newFile = false
        path = null
      }
      if (line.startsWith('@@')) {
        inHunk = true
        kind = 'hunk'
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
        nextLine = hunk === null ? null : Number(hunk[1])
        // The untracked-file preview uses +<row count> without a start/count pair.
        if (newFile && /^@@ -0,0 \+\d+ @@/.test(line)) nextLine = 1
      } else if (
        /^\+?… \d+ more (?:diff )?lines not shown$/.test(line) ||
        line.startsWith('binary or unreadable file:') ||
        line.startsWith('Binary files ') ||
        line.startsWith('\\ No newline at end of file')
      ) {
        kind = 'note'
      } else if (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ '))) {
        kind = 'header'
        if (line.startsWith('--- ')) newFile = line === '--- /dev/null'
        if (line.startsWith('+++ ')) path = newSidePath(line)
      } else if (line.startsWith('+')) {
        kind = 'add'
      } else if (line.startsWith('-')) {
        kind = 'del'
      }
      // Deletions and no-newline/truncation notes never consume a new-side line.
      if (inHunk && nextLine !== null && (kind === 'add' || (kind === 'ctx' && line.startsWith(' ')))) {
        newLine = nextLine > 0 ? nextLine : null
        nextLine++
      }
      const stripPrefix =
        kind === 'add' ||
        kind === 'del' ||
        (kind === 'ctx' && line.startsWith(' ')) ||
        (kind === 'note' && line.startsWith('+… '))
      return { text: stripPrefix ? line.slice(1) : line, kind, newLine, path }
    })
}

const GUTTER: Record<RowKind, string> = { add: '+', del: '−', hunk: '', header: '', note: '', ctx: '' }

/** The viewer body owns scrolling; the row canvas grows to fit the longest line. */
export function DiffView({ workspaceId, path }: { workspaceId: string; path: string }) {
  // A file switch also discards its editor and ignores any late comment requests.
  return <DiffFile key={cacheKey(workspaceId, path)} workspaceId={workspaceId} path={path} />
}

function DiffFile({ workspaceId, path }: { workspaceId: string; path: string }) {
  const readOnly = useProjects(
    (state) =>
      Object.values(state.workspacesByProject)
        .flat()
        .find((row) => row.id === workspaceId)?.bot?.access === 'view'
  )
  const diff = useFiles((s) => s.diffByPath[cacheKey(workspaceId, path)])
  const push = useToasts((s) => s.push)
  const [comments, setComments] = useState<CommentRow[]>([])
  const [editingLine, setEditingLine] = useState<string | null>(null)
  const [mutating, setMutating] = useState(false)
  const request = useRef({ active: false, version: 0, mutating: false })
  const opener = useRef<HTMLButtonElement | null>(null)
  const editorId = useId()

  async function refreshComments() {
    const current = request.current
    const version = ++current.version
    try {
      const items = await window.loom.comments.list(workspaceId)
      if (current.active && current.version === version) setComments(items)
    } catch (err) {
      if (current.active && current.version === version)
        push(`Could not load comments: ${String(err)}`, 'err')
    }
  }

  useEffect(() => {
    const current = request.current
    current.active = true
    void refreshComments()
    return () => {
      current.active = false
      current.version++
    }
  }, [workspaceId, path])

  function closeEditor() {
    setEditingLine(null)
    // Wait for a successful save to re-enable the gutter button before focusing it.
    requestAnimationFrame(() => {
      if (opener.current?.isConnected) opener.current.focus()
    })
  }

  async function saveComment(commentPath: string, line: number, body: string): Promise<boolean> {
    const current = request.current
    if (readOnly || current.mutating) return false
    current.mutating = true
    setMutating(true)
    try {
      const comment = await window.loom.comments.add({ workspaceId, path: commentPath, line, body })
      if (current.active) {
        setComments((items) => [...items, comment])
        await refreshComments()
      }
      return true
    } catch (err) {
      if (current.active) push(`Could not save comment: ${String(err)}`, 'err')
      return false
    } finally {
      current.mutating = false
      if (current.active) setMutating(false)
    }
  }

  async function removeComment(id: string) {
    const current = request.current
    if (readOnly || current.mutating) return
    current.mutating = true
    setMutating(true)
    try {
      await window.loom.comments.remove(id)
      if (current.active) {
        setComments((items) => items.filter((item) => item.id !== id))
        await refreshComments()
      }
    } catch (err) {
      if (current.active) push(`Could not remove comment: ${String(err)}`, 'err')
    } finally {
      current.mutating = false
      if (current.active) setMutating(false)
    }
  }

  if (diff === undefined) return <div className="viewer-empty">Loading…</div>
  if (diff === '') return <div className="viewer-empty">No differences to display.</div>
  const commentsByLine = new Map<string, CommentRow[]>()
  for (const comment of comments) {
    const key = cacheKey(comment.path, String(comment.line))
    const items = commentsByLine.get(key) ?? []
    items.push(comment)
    commentsByLine.set(key, items)
  }
  return (
    <div className="diff-body" role="region" aria-label={`Diff of ${path}`}>
      {diffRows(diff).map(({ text, kind, newLine, path: rowPath }, i) => {
        // Checkpoint views contain multiple files, so use each hunk's actual new-side path.
        const commentPath = path.startsWith('@checkpoint/') ? rowPath : path
        const lineKey =
          commentPath !== null && newLine !== null ? cacheKey(commentPath, String(newLine)) : null
        return (
          <Fragment key={`${i}:${lineKey}:${text}`}>
            <div className="diff-row" data-kind={kind}>
              <span className="diff-comment-gutter">
                {!readOnly && newLine !== null && lineKey !== null && (
                  <button
                    type="button"
                    className="diff-comment-add"
                    aria-label={`Comment on line ${newLine}`}
                    aria-expanded={editingLine === lineKey}
                    aria-controls={editingLine === lineKey ? editorId : undefined}
                    title={`Comment on ${commentPath}:${newLine}`}
                    disabled={mutating}
                    onClick={(event) => {
                      opener.current = event.currentTarget
                      setEditingLine(lineKey)
                    }}
                  >
                    +
                  </button>
                )}
              </span>
              <span className="diff-line-number" aria-hidden="true">
                {newLine}
              </span>
              <span className="diff-gutter" aria-hidden={kind !== 'add' && kind !== 'del'}>
                {GUTTER[kind]}
              </span>
              <span className="diff-text">{text}</span>
            </div>
            {lineKey !== null &&
              commentsByLine.get(lineKey)?.map((comment) => (
                <div
                  key={comment.id}
                  className="diff-comment-row"
                  role="group"
                  aria-label={`Comment on line ${newLine}`}
                >
                  <svg
                    className="diff-comment-glyph"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    aria-hidden="true"
                  >
                    <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z" />
                  </svg>
                  <div className="diff-comment-copy">
                    <p className="diff-comment-body">{comment.body}</p>
                    <time
                      className="diff-comment-time"
                      dateTime={new Date(comment.createdAt).toISOString()}
                      title={new Date(comment.createdAt).toLocaleString()}
                    >
                      {new Date(comment.createdAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit'
                      })}
                    </time>
                  </div>
                  {!readOnly && (
                    <button
                      type="button"
                      className="diff-comment-remove"
                      aria-label={`Remove comment on line ${newLine}`}
                      disabled={mutating}
                      onClick={() => void removeComment(comment.id)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            {!readOnly &&
              newLine !== null &&
              commentPath !== null &&
              lineKey !== null &&
              editingLine === lineKey && (
                <CommentComposer
                  key={newLine}
                  id={editorId}
                  line={newLine}
                  pending={mutating}
                  onSave={(body) => saveComment(commentPath, newLine, body)}
                  onClose={closeEditor}
                />
              )}
          </Fragment>
        )
      })}
    </div>
  )
}

function CommentComposer({
  id,
  line,
  pending,
  onSave,
  onClose
}: {
  id: string
  line: number
  pending: boolean
  onSave(body: string): Promise<boolean>
  onClose(): void
}) {
  const [body, setBody] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const saving = useRef(false)
  useEffect(() => ref.current?.focus(), [])

  async function save() {
    if (pending || saving.current || body.trim() === '') return
    saving.current = true
    try {
      if (await onSave(body.trim())) onClose()
    } finally {
      saving.current = false
    }
  }

  return (
    <form
      id={id}
      className="diff-comment-form"
      aria-label={`Review comment on line ${line}`}
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!pending) onClose()
        }
      }}
    >
      <textarea
        ref={ref}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        aria-label={`Comment on line ${line}`}
        placeholder="Leave a review comment…"
        maxLength={4000}
        disabled={pending}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void save()
          }
        }}
      />
      <div className="diff-comment-actions">
        <span className="diff-comment-hint">↵ save · ⇧↵ newline</span>
        <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending || body.trim() === ''}>
          Save
        </button>
      </div>
    </form>
  )
}
