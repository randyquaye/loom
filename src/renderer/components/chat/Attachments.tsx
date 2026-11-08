import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { MAX_ATTACHMENTS, useUi } from '../../state/ui'
import { ErrorState } from '../ui/ErrorState'
import { useToasts } from '../ui/Toast'

/** Absolute paths come from the native dialog; everything else is workspace-relative. */
function isExternalPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

const LIST_DIR_BATCH = 16
const MAX_LISTED_DIRS = 600
const MAX_LISTED_FILES = 20000

/**
 * files.tree lists one level only, so the picker walks folders breadth-first through listDir
 * (main already skips .git and node_modules). Bounded so a huge monorepo cannot stall it.
 */
async function listWorkspaceFiles(workspaceId: string): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = []
  let dirs: string[] = []
  for (const node of await window.loom.files.tree(workspaceId)) {
    if (node.kind === 'file') paths.push(node.path)
    else dirs.push(node.path)
  }
  let listed = 0
  while (dirs.length > 0 && listed < MAX_LISTED_DIRS && paths.length < MAX_LISTED_FILES) {
    const batch = dirs.slice(0, Math.min(LIST_DIR_BATCH, MAX_LISTED_DIRS - listed))
    dirs = dirs.slice(batch.length)
    listed += batch.length
    const levels = await Promise.all(batch.map((dir) => window.loom.files.listDir(workspaceId, dir)))
    for (const node of levels.flat()) {
      if (node.kind === 'file') paths.push(node.path)
      else dirs.push(node.path)
    }
  }
  return {
    paths: paths.slice(0, MAX_LISTED_FILES),
    truncated: dirs.length > 0 || paths.length > MAX_LISTED_FILES
  }
}

const MAX_PICKER_ROWS = 50

/** Stroked with currentColor so it follows the ghost button's muted/hover text colour. */
function PaperclipGlyph() {
  return (
    <svg className="composer-attach-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 4.5 5.8 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5 5a4.5 4.5 0 0 0 6.4 6.4l4.2-4.2" />
    </svg>
  )
}

/**
 * Paperclip in the session composer footer: a searchable list of workspace files plus the
 * native dialog for anything outside the worktree. The listing is fetched afresh on every
 * open so newly created files show up; typing only filters it.
 */
export function AttachPicker({
  workspaceId,
  sessionId,
  disabled
}: {
  workspaceId: string
  sessionId: string
  disabled: boolean
}) {
  const attached = useUi((s) => s.attachmentsBySession[sessionId])
  const push = useToasts((s) => s.push)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [files, setFiles] = useState<{ paths: string[]; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const baseId = useId()
  const count = attached?.length ?? 0
  const full = count >= MAX_ATTACHMENTS

  useEffect(() => {
    if (!open) return
    let live = true
    setFiles(null)
    setError(null)
    listWorkspaceFiles(workspaceId).then(
      (result) => {
        if (live) setFiles(result)
      },
      (err: unknown) => {
        if (live) setError(String(err))
      }
    )
    return () => {
      live = false
    }
  }, [open, workspaceId, attempt])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) close(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const q = query.trim().toLowerCase()
  const matches =
    files === null ? [] : q === '' ? files.paths : files.paths.filter((p) => p.toLowerCase().includes(q))
  const shown = matches.slice(0, MAX_PICKER_ROWS)
  // The external row is the last keyboard stop, after the listed files.
  const rowCount = shown.length + 1
  const activeIndex = Math.min(active, rowCount - 1)

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  function close(refocus: boolean) {
    setOpen(false)
    setQuery('')
    if (refocus) triggerRef.current?.focus()
  }

  function pickFile(path: string) {
    useUi.getState().addAttachment(sessionId, path)
    close(true)
  }

  async function pickExternal() {
    close(true)
    try {
      const { paths } = await window.loom.files.pickExternal()
      const ui = useUi.getState()
      for (const path of paths) ui.addAttachment(sessionId, path)
      const now = useUi.getState().attachmentsBySession[sessionId] ?? []
      if (paths.some((path) => !now.includes(path)))
        push(`Only ${MAX_ATTACHMENTS} files can be attached to one message`, 'err')
    } catch (err) {
      push(`Could not open the file dialog: ${String(err)}`, 'err')
    }
  }

  function choose(index: number) {
    const path = shown[index]
    if (path !== undefined) pickFile(path)
    else if (index === shown.length) void pickExternal()
  }

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((activeIndex + step + rowCount) % rowCount)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(activeIndex)
    }
  }

  return (
    <div className="popover-wrap composer-attach-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="composer-icon composer-attach-btn"
        aria-label="Attach files"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled || full}
        title={full ? `Up to ${MAX_ATTACHMENTS} files per message` : 'Attach files'}
        onClick={() => {
          if (open) close(false)
          else {
            setActive(0)
            setOpen(true)
          }
        }}
      >
        <PaperclipGlyph />
      </button>
      {open && (
        <div
          className="composer-attach-picker elevated"
          role="dialog"
          aria-label="Attach files"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Keep Escape local: an enclosing surface must not close too.
              e.stopPropagation()
              close(true)
            }
          }}
        >
          <label className="composer-attach-search">
            <span className="composer-attach-search-glyph" aria-hidden="true">
              ⌕
            </span>
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onSearchKey}
              placeholder="Search workspace files"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${baseId}-list`}
              aria-activedescendant={`${baseId}-row-${activeIndex}`}
            />
          </label>
          <div ref={listRef} id={`${baseId}-list`} className="composer-attach-list" role="listbox">
            {error !== null && (
              <ErrorState
                compact
                title="Couldn’t list workspace files"
                detail={error}
                onRetry={() => setAttempt((n) => n + 1)}
              />
            )}
            {error === null && files === null && <div className="composer-attach-empty">Loading files…</div>}
            {files !== null && matches.length === 0 && (
              <div className="composer-attach-empty">
                {q === '' ? 'No files in this workspace.' : `No files match “${query}”.`}
              </div>
            )}
            {shown.map((path, i) => {
              const on = attached?.includes(path) === true
              return (
                <button
                  key={path}
                  id={`${baseId}-row-${i}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={on}
                  className="list-option composer-attach-row"
                  data-index={i}
                  data-active={i === activeIndex}
                  title={path}
                  onMouseMove={() => setActive(i)}
                  onClick={() => pickFile(path)}
                >
                  <span className="composer-attach-path">{path}</span>
                  <span className="composer-attach-check" aria-hidden="true">
                    {on ? '✓' : ''}
                  </span>
                </button>
              )
            })}
            {matches.length > shown.length && (
              <div className="composer-attach-more">
                …and {matches.length - shown.length} more — keep typing
              </div>
            )}
            {files?.truncated === true && matches.length <= shown.length && (
              <div className="composer-attach-more">Large workspace: not every folder was listed.</div>
            )}
            <div className="composer-attach-sep" role="separator" />
            <button
              id={`${baseId}-row-${shown.length}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={false}
              className="list-option composer-attach-row"
              data-index={shown.length}
              data-active={activeIndex === shown.length}
              onMouseMove={() => setActive(shown.length)}
              onClick={() => void pickExternal()}
            >
              <span className="composer-attach-ext" aria-hidden="true">
                ↗
              </span>
              <span className="grow">Attach from anywhere…</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Files queued for the next send: one removable chip each; collapses to nothing when empty. */
export function AttachChips({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const attached = useUi((s) => s.attachmentsBySession[sessionId]) ?? []
  return (
    <div className="composer-attach-slot">
      <ul
        className="composer-attach"
        aria-label="Attached files"
        aria-live="polite"
        aria-relevant="additions removals"
      >
        {attached.map((path, index) => {
          const external = isExternalPath(path)
          const label = external ? basename(path) : path
          return (
            <li className="composer-attach-chip" key={path} data-external={external} title={path}>
              {external && (
                <span className="composer-attach-ext" title="Outside the workspace">
                  ↗<span className="composer-attach-hidden"> outside workspace:</span>
                </span>
              )}
              <span className="composer-attach-name">{label}</span>
              <button
                type="button"
                className="composer-attach-remove"
                aria-label={`Remove attachment ${label}`}
                disabled={disabled}
                onClick={() => useUi.getState().removeAttachment(sessionId, index)}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
