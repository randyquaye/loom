import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { SessionRow } from '../../../shared/ipc-contract'
import { EFFORTS, type BackendId, type Effort } from '../../../shared/models'
import { FIX_ERRORS_PROMPT, REVIEW_DIFF_PROMPT } from '../../../shared/prompts/flows'
import { initialChoice, useDefaults } from '../../state/defaults'
import { useFiles } from '../../state/files'
import { useProjects } from '../../state/projects'
import { isTurnRunning, useSessions } from '../../state/sessions'
import { MAX_ATTACHMENTS, useUi } from '../../state/ui'
import { MicGlyph, useTalk } from '../../audio/talk'
import { ErrorState } from '../ui/ErrorState'
import { useToasts } from '../ui/Toast'
import { WeaveMark } from '../ui/WeaveMark'
import { ContextDonut } from './ContextDonut'
import { ModelPicker } from './ModelPicker'
import './flow.css'

export function Composer({
  workspaceId,
  sessionId,
  disabled
}: {
  workspaceId: string
  sessionId: string | null
  disabled: boolean
}) {
  if (sessionId === null)
    return <StartComposer key={`new:${workspaceId}`} workspaceId={workspaceId} disabled={disabled} />
  return <SessionComposer key={sessionId} sessionId={sessionId} disabled={disabled} />
}

interface Choice {
  backend: BackendId
  model: string
  effort: Effort
}

type Flow = 'review' | 'fix'

async function flowContext(workspaceId: string, flow: Flow): Promise<string> {
  // Refresh even when Changes has a cache: a flow must use the current worktree.
  await useFiles.getState().loadChanges(workspaceId)
  const changes = useFiles.getState().changesByWorkspace[workspaceId] ?? []
  const diffs = await Promise.all(
    changes.slice(0, 6).map(async ({ path }) => {
      const diff = await window.loom.git.diff(workspaceId, path)
      const lines = diff.split(/\r?\n/)
      const excerpt = lines.slice(0, 150).join('\n')
      const truncated = lines.length > 150 ? '\n[Diff truncated after 150 lines.]' : ''
      return `--- ${path}\n${excerpt || 'No textual diff available.'}${truncated}`
    })
  )
  let context = `\n\nCurrent uncommitted changes:\n${diffs.join('\n\n') || 'No uncommitted changes.'}`
  if (flow === 'fix') {
    const lintable = changes
      .filter(({ path, status }) => status !== 'deleted' && /\.(ts|tsx|js|json|py)$/i.test(path))
      .slice(0, 4)
    const diagnostics = await Promise.all(
      lintable.map(async ({ path }) => {
        // Opening through useFiles would activate the pinned viewer and leave the chat.
        const { text } = await window.loom.files.read(workspaceId, path)
        const results = await window.loom.lint.run(workspaceId, path, text)
        return results.map(({ line, message }) => `${path}:${line} ${message.replace(/\s*\r?\n\s*/g, ' ')}`)
      })
    )
    const summary = lintable.length === 0 ? 'No changed lintable files.' : 'No diagnostics reported.'
    context += `\n\nDiagnostics:\n${diagnostics.flat().join('\n') || summary}`
  }
  return context
}

/** Absolute paths come from the native dialog; everything else is workspace-relative. */
function isExternalPath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(path)
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * Electron wraps errors thrown in main ("Error invoking remote method …: Error: …"), so the
 * ATTACHMENT_REJECTED prefix is matched anywhere in the message, not only at its start.
 */
function sendFailure(err: unknown): string {
  const rejected = /ATTACHMENT_REJECTED:\s*([\s\S]*)$/.exec(String(err))
  return rejected === null ? `Send failed: ${String(err)}` : `Attachment rejected: ${rejected[1] ?? ''}`
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
function AttachPicker({
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
        className="btn btn-ghost composer-tool composer-attach-btn"
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
          className="composer-attach-picker glass"
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
function AttachChips({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
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

/** SessionRow.effort is a plain string on the wire; anything unknown reads as medium. */
function asEffort(value: string): Effort {
  return (EFFORTS as readonly string[]).includes(value) ? (value as Effort) : 'medium'
}

/**
 * Composer text that survives remounts (tab switches, the viewer tab, route changes): restored
 * from the ui store on mount and saved on every change. A one-shot draft from a quick prompt
 * replaces it and focuses the field whenever it arrives, mounted or not.
 */
function useComposeText(key: string) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [text, setLocal] = useState(() => useUi.getState().draftBySession[key] ?? '')
  const incoming = useUi((s) => s.draft)

  function setText(next: string) {
    setLocal(next)
    useUi.getState().saveComposeDraft(key, next)
  }

  useEffect(() => {
    if (incoming === null) return
    useUi.getState().setDraft(null)
    setLocal(incoming)
    useUi.getState().saveComposeDraft(key, incoming)
    // Focus once the new value has rendered so the caret lands at its end. Not cancelled on
    // cleanup: clearing the draft re-runs this effect before the frame fires.
    requestAnimationFrame(() => {
      const el = ref.current
      if (el === null) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
  }, [incoming, key])

  return { text, setText, ref }
}

/**
 * No session yet: the picker shows the loadout's first entry until the user
 * picks something, and sending creates the session with what it shows. The
 * default is derived, not copied into state, so it tracks Settings edits and
 * late-loading catalogs without a sync effect.
 */
function StartComposer({ workspaceId, disabled }: { workspaceId: string; disabled: boolean }) {
  const create = useSessions((s) => s.create)
  const send = useSessions((s) => s.send)
  const push = useToasts((s) => s.push)
  const loadout = useDefaults((s) => s.loadout)
  const modelsByBackend = useSessions((s) => s.modelsByBackend)
  const [picked, setPicked] = useState<Choice | null>(null)
  const draftKey = `new:${workspaceId}`
  const { text, setText, ref } = useComposeText(draftKey)
  const [pending, setPending] = useState<Flow | 'message' | null>(null)
  const inFlight = useRef(false)
  const busy = pending !== null

  const choice: Choice = picked ?? initialChoice(loadout, modelsByBackend)
  const { backend, model, effort } = choice

  async function submit(flow?: Flow) {
    if (disabled || inFlight.current || model === '' || (flow === undefined && text.trim() === '')) return
    inFlight.current = true
    setPending(flow ?? 'message')
    let prompt = text
    let created: string | null = null
    try {
      if (flow !== undefined) {
        const { projects, workspacesByProject } = useProjects.getState()
        const workspace = Object.values(workspacesByProject)
          .flat()
          .find((row) => row.id === workspaceId)
        const project = projects.find((row) => row.id === workspace?.projectId)
        if (project === undefined) throw new Error('Project not available for this workspace.')
        const template =
          flow === 'review'
            ? (project.customPromptCodeReview ?? REVIEW_DIFF_PROMPT)
            : (project.customPromptFixErrors ?? FIX_ERRORS_PROMPT)
        prompt = template + (await flowContext(workspaceId, flow))
      }
      const session = await create(workspaceId, backend, model, effort)
      created = session.id
      // A flow spends its generated prompt; keep any separately typed draft for later.
      if (flow === undefined) useUi.getState().saveComposeDraft(draftKey, '')
      await send(session.id, prompt)
    } catch (err) {
      if (created === null) {
        push(`Could not start session: ${String(err)}`, 'err')
      } else {
        push(`Send failed: ${String(err)}`, 'err')
        // Hand the prompt to the session composer that replaced this one, so nothing is lost.
        useUi.getState().setDraft(prompt)
      }
    } finally {
      inFlight.current = false
      setPending(null)
    }
  }

  return (
    <div className="composer composer-start">
      <div className="empty-state composer-start-empty">
        <WeaveMark />
        <div className="empty-title">What should we build?</div>
        <div className="quick-chips" role="group" aria-label="Quick actions">
          <button
            type="button"
            className="chip"
            disabled={disabled || busy}
            onClick={() => useUi.getState().setDraft('Summarize repo')}
          >
            Summarize repo
          </button>
          <button
            type="button"
            className="chip"
            disabled={disabled || busy}
            onClick={() => useUi.getState().setDraft('Plan a change')}
          >
            Plan a change
          </button>
          <button
            type="button"
            className="chip"
            disabled={disabled || busy || model === ''}
            aria-label="Review diff"
            aria-busy={pending === 'review'}
            onClick={() => void submit('review')}
          >
            {pending === 'review' ? 'Preparing review…' : 'Review diff'}
          </button>
          <button
            type="button"
            className="chip"
            disabled={disabled || busy || model === ''}
            aria-label="Fix errors"
            aria-busy={pending === 'fix'}
            onClick={() => void submit('fix')}
          >
            {pending === 'fix' ? 'Collecting diagnostics…' : 'Fix errors'}
          </button>
        </div>
        <div className="composer-start-hint" role="status">
          {pending === 'review'
            ? 'Collecting current changes…'
            : pending === 'fix'
              ? 'Collecting current changes and diagnostics…'
              : 'Ask an agent below. File paths in replies open in the viewer.'}
        </div>
      </div>
      <div className="composer composer-start-input">
        <fieldset className="composer-box" disabled={disabled || busy} aria-label="Message composer">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask anything…"
            aria-label="Message"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div className="composer-footer">
            <ModelPicker
              backend={backend}
              model={model}
              effort={effort}
              onPick={(b, m, e) => {
                if (!disabled && !busy) setPicked({ backend: b, model: m, effort: e })
              }}
            />
            <span className="grow" />
            <button
              className="send-btn"
              onClick={() => void submit()}
              disabled={disabled || busy || model === '' || text.trim() === ''}
              title="Send"
              aria-label="Send"
            >
              ↑
            </button>
          </div>
        </fieldset>
      </div>
    </div>
  )
}

function SessionComposer({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const cancel = useSessions((s) => s.cancel)
  const fork = useSessions((s) => s.fork)
  const session = useSessions(
    (s) =>
      Object.values(s.sessionsByWorkspace)
        .flat()
        .find((row) => row.id === sessionId) ?? null
  )
  // Derived from the event stream, so a turn started elsewhere (e.g. the first turn sent by the
  // start composer just before this one mounted) still shows Cancel.
  const running = useSessions((s) => isTurnRunning(s.eventsBySession[sessionId] ?? []))
  const push = useToasts((s) => s.push)
  const { text, setText, ref } = useComposeText(sessionId)
  const talk = useTalk(sessionId)
  const [queue, setQueue] = useState<string[]>([])
  const [removing, setRemoving] = useState(false)
  const queueRequest = useRef({ revision: 0, removing: false, active: false })
  const busy = running

  useEffect(() => {
    const request = queueRequest.current
    request.active = true
    let active = true
    let pushed = false
    const unsubscribe = window.loom.onSessionQueue((update) => {
      if (update.sessionId !== sessionId) return
      pushed = true
      request.revision++
      setQueue(update.items)
    })
    void window.loom.sessions.queue(sessionId).then(
      (items) => {
        // A live push wins over an older snapshot that was already in flight.
        if (active && !pushed) setQueue(items)
      },
      (err: unknown) => {
        if (active && !pushed) push(`Could not load queue: ${String(err)}`, 'err')
      }
    )
    return () => {
      active = false
      request.active = false
      unsubscribe()
    }
  }, [sessionId, push])

  async function removeQueued(index: number) {
    const request = queueRequest.current
    if (request.removing) return
    request.removing = true
    setRemoving(true)
    const revision = request.revision
    try {
      const items = await window.loom.sessions.dequeue(sessionId, index)
      if (request.active && request.revision === revision) setQueue(items)
    } catch (err) {
      if (request.active) push(`Could not remove queued message: ${String(err)}`, 'err')
    } finally {
      request.removing = false
      if (request.active) setRemoving(false)
    }
  }

  /** Model/effort are fixed per session: a different pick forks into a new, immediately active tab. */
  function forkTo(source: SessionRow, backend: BackendId, model: string, effort: Effort) {
    if (disabled) return
    const label = useSessions.getState().modelsByBackend[backend]?.find((m) => m.id === model)?.label ?? model
    fork({ workspaceId: source.workspaceId, backend, model, effort, sourceSessionId: source.id })
      .then(() => push(`Forked to ${label}`))
      .catch((err: unknown) => push(`Fork failed: ${String(err)}`, 'err'))
  }

  /**
   * Spends the draft text and attachments synchronously, so rapid clicks cannot submit them
   * twice. A send may stay pending for the whole turn, so chips are not held until it resolves
   * (a follow-up queued meanwhile would re-send them); a failure restores both instead.
   */
  async function deliver(interrupt: boolean) {
    const prompt = useUi.getState().draftBySession[sessionId] ?? text
    if (disabled || prompt.trim() === '') return
    const attachments = useUi.getState().attachmentsBySession[sessionId] ?? []
    setText('')
    useUi.getState().clearAttachments(sessionId)
    try {
      // The store's send/sendNow take no attachments; call the bridge directly.
      if (interrupt) await window.loom.sessions.sendNow(sessionId, prompt, attachments)
      else await window.loom.sessions.send(sessionId, prompt, attachments)
    } catch (err) {
      push(sendFailure(err), 'err')
      const currentDraft = useUi.getState().draftBySession[sessionId] ?? ''
      setText(currentDraft === '' ? prompt : `${prompt}\n${currentDraft}`)
      const ui = useUi.getState()
      const added = ui.attachmentsBySession[sessionId] ?? []
      ui.clearAttachments(sessionId)
      for (const path of [...attachments, ...added]) ui.addAttachment(sessionId, path)
    }
  }

  function submit() {
    return deliver(false)
  }

  /** Interrupts the turn in flight and sends the draft ahead of anything queued. */
  function submitNow() {
    return deliver(true)
  }

  return (
    <div className="composer composer-session">
      <div className="composer-queue-slot">
        <ol
          className="composer-queue"
          aria-label="Queued messages"
          aria-live="polite"
          aria-relevant="additions removals"
        >
          {queue.map((message, index) => (
            <li className="composer-queue-chip" key={`${index}:${message}`}>
              <span className="composer-queue-index">{index + 1}</span>
              <span className="composer-queue-text" title={message}>
                {message.replace(/\s+/g, ' ')}
              </span>
              <span className="composer-queue-tag">queued</span>
              <button
                type="button"
                className="composer-queue-remove"
                aria-label={`Remove queued message ${index + 1}`}
                disabled={disabled || removing}
                onClick={() => void removeQueued(index)}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      </div>
      <AttachChips sessionId={sessionId} disabled={disabled} />
      {(talk.phase !== 'idle' || talk.finalized !== null || talk.stt.error !== null) && (
        <div className="stt-strip" role="status">
          {talk.stt.error !== null ? (
            <span className="stt-error">{talk.stt.error}</span>
          ) : talk.finalized !== null ? (
            <span className="stt-final">{talk.finalized}</span>
          ) : (
            <span className="stt-live">
              {[...talk.stt.committed, talk.stt.live].filter((part) => part !== '').join(' ')}
            </span>
          )}
          {talk.phase === 'capturing' && (
            <button type="button" className="btn btn-ghost" onClick={talk.cancel}>
              Cancel
            </button>
          )}
        </div>
      )}
      <fieldset className="composer-box" disabled={disabled} aria-label="Message composer">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask anything…"
          aria-label="Message"
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return
            e.preventDefault()
            if (e.metaKey || e.ctrlKey) void submitNow()
            else void submit()
          }}
        />
        <div className="composer-footer">
          {session !== null && (
            <>
              <ModelPicker
                mode="fork"
                backend={session.backend}
                model={session.model}
                effort={asEffort(session.effort)}
                onPick={(backend, model, effort) => forkTo(session, backend, model, effort)}
              />
              <ContextDonut session={session} />
            </>
          )}
          <AttachPicker
            workspaceId={session?.workspaceId ?? ''}
            sessionId={sessionId}
            disabled={disabled || session === null}
          />
          <button
            type="button"
            className="composer-tool talk-btn"
            data-phase={talk.phase}
            disabled={disabled}
            title={talk.phase === 'idle' ? 'Hold to talk' : 'Release to finish'}
            aria-label={talk.phase === 'idle' ? 'Hold to talk' : 'Release to finish'}
            onPointerDown={() => void talk.press()}
            onPointerUp={() => void talk.release()}
            onPointerLeave={() => {
              if (talk.phase === 'capturing') void talk.release()
            }}
          >
            <MicGlyph />
          </button>
          <span className="grow" />
          <button
            className="btn btn-ghost composer-tool composer-sendnow"
            data-visible={busy}
            disabled={disabled || !busy || text.trim() === ''}
            title="Interrupt the running turn and send this message now"
            onClick={() => void submitNow()}
          >
            Send now
          </button>
          <button
            className="btn btn-ghost composer-tool composer-cancel"
            data-visible={busy}
            disabled={disabled || !busy}
            onClick={() =>
              void cancel(sessionId).catch((err: unknown) => push(`Cancel failed: ${String(err)}`, 'err'))
            }
          >
            Cancel
          </button>
          <button
            className="send-btn"
            onClick={() => void submit()}
            disabled={disabled || text.trim() === ''}
            title={busy ? 'Queue message' : 'Send'}
            aria-label={busy ? 'Queue message' : 'Send'}
          >
            <span aria-hidden="true">↑</span>
            {busy ? 'Queue' : 'Send'}
          </button>
        </div>
      </fieldset>
    </div>
  )
}
