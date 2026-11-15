import { cacheKey, useFiles } from '../../state/files'
import { useSessions } from '../../state/sessions'
import { useProjects } from '../../state/projects'
import { MAX_ATTACHMENTS, useUi } from '../../state/ui'
import { useToasts } from '../ui/Toast'
import '../panels/panels.css'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { DiffView } from './DiffView'
import { ImageView } from './ImageView'
import { MarkdownView } from './MarkdownView'
import { MonacoView } from './MonacoView'

export function ViewerHost({ workspaceId }: { workspaceId: string }) {
  const workspace = useProjects((state) =>
    Object.values(state.workspacesByProject)
      .flat()
      .find((row) => row.id === workspaceId)
  )
  const readOnly = workspace?.bot?.access === 'view'
  const openPath = useFiles((s) => s.openPathByWorkspace[workspaceId] ?? null)
  const mode = useFiles((s) => s.viewerModeByWorkspace[workspaceId] ?? 'content')
  const contentByPath = useFiles((s) => s.contentByPath)
  const diagnosticsByPath = useFiles((s) => s.diagnosticsByPath)
  const revealLine = useFiles((s) => s.revealLineByWorkspace[workspaceId] ?? null)
  const openAt = useFiles((s) => s.openAt)
  // '' is compose mode (no session yet): nothing to attach to.
  const sessionId = useSessions((s) => s.activeSessionByWorkspace[workspaceId] || null)
  const attached = useUi((s) => (sessionId === null ? undefined : s.attachmentsBySession[sessionId]))
  const push = useToasts((s) => s.push)

  if (openPath === null) return <div className="viewer-empty">Select a file to view</div>
  const key = cacheKey(workspaceId, openPath)
  const content = contentByPath[key]
  if (mode === 'content' && content === undefined) return <div className="viewer-empty">Loading…</div>
  const diagnostics = diagnosticsByPath[key] ?? []
  const hasErrors = diagnostics.some((d) => d.severity === 'error')
  // Count what the drawer summary counts (errors + warnings), so the header
  // pill and the drawer never disagree; info-level notes stay out of both.
  const problemCount = diagnostics.filter((d) => d.severity !== 'info').length
  const slash = openPath.lastIndexOf('/')
  const checkpointName = openPath.startsWith('@checkpoint/')
    ? `checkpoint ${openPath.slice('@checkpoint/'.length)}`
    : null

  return (
    <div className="viewer viewer-host" data-mode={mode}>
      <div className="viewer-head">
        <span className="viewer-path" title={checkpointName ?? openPath}>
          {checkpointName === null && slash >= 0 && (
            <span className="viewer-dir">{openPath.slice(0, slash + 1)}</span>
          )}
          <span className="viewer-name">{checkpointName ?? openPath.slice(slash + 1)}</span>
        </span>
        <span className="panel-pill">
          {mode === 'diff' ? 'diff' : content?.kind === 'image' ? content.mimeType : content?.language}
        </span>
        {mode === 'content' && problemCount > 0 && (
          <span className="panel-pill" data-tone={hasErrors ? 'danger' : 'warn'}>
            {problemCount}
          </span>
        )}
        {checkpointName === null && !workspace?.cloud && (
          <button
            type="button"
            className="btn btn-ghost viewer-action"
            title="Reveal this file in Finder"
            onClick={() => {
              void window.loom.files.reveal(workspaceId, openPath).catch((err: unknown) => {
                push(`Could not reveal ${openPath}: ${String(err)}`, 'err')
              })
            }}
          >
            Reveal in Finder
          </button>
        )}
        {checkpointName === null && !readOnly && (
          <AttachButton
            path={openPath}
            sessionId={sessionId}
            attached={attached?.includes(openPath) === true}
            full={(attached?.length ?? 0) >= MAX_ATTACHMENTS}
            onAttached={(name) => push(`Attached ${name}`)}
          />
        )}
      </div>
      <div className="viewer-body">
        {mode === 'diff' ? (
          <DiffView workspaceId={workspaceId} path={openPath} />
        ) : content?.kind === 'image' ? (
          <ImageView key={key} src={content.dataUrl} label={openPath} />
        ) : content?.language === 'markdown' ? (
          <MarkdownView text={content.text} onOpen={(path, line) => void openAt(workspaceId, path, line)} />
        ) : content !== undefined ? (
          <MonacoView
            path={`${workspaceId}/${openPath}`}
            text={content.text}
            diagnostics={diagnostics}
            revealLine={revealLine}
          />
        ) : null}
      </div>
      {mode === 'content' && content?.kind === 'text' && <DiagnosticsPanel diagnostics={diagnostics} />}
    </div>
  )
}

/** Adds the open file to the active session's next message; disabled when it cannot. */
function AttachButton({
  path,
  sessionId,
  attached,
  full,
  onAttached
}: {
  path: string
  sessionId: string | null
  attached: boolean
  full: boolean
  onAttached: (name: string) => void
}) {
  const title =
    sessionId === null
      ? 'Start a chat to attach files'
      : attached
        ? 'Already attached to the next message'
        : full
          ? `Up to ${MAX_ATTACHMENTS} files per message`
          : 'Attach this file to the next message'
  return (
    <button
      type="button"
      className="btn btn-ghost viewer-action"
      disabled={sessionId === null || attached || full}
      title={title}
      onClick={() => {
        if (sessionId === null) return
        useUi.getState().addAttachment(sessionId, path)
        onAttached(path.slice(path.lastIndexOf('/') + 1))
      }}
    >
      {attached ? 'Attached' : 'Attach'}
    </button>
  )
}
