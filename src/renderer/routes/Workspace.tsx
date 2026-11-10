import { useEffect, useState } from 'react'
import { Composer } from '../components/chat/Composer'
import { MessageList } from '../components/chat/MessageList'
import { SessionTabs } from '../components/chat/SessionTabs'
import { FileTree } from '../components/explorer/FileTree'
import { PrStatus } from '../components/integrations/PrStatus'
import { XtermPane } from '../components/terminal/XtermPane'
import { Splitter } from '../components/ui/Splitter'
import { useToasts } from '../components/ui/Toast'
import { ViewerHost } from '../components/viewer/ViewerHost'
import { useFiles } from '../state/files'
import { RIGHT_DEFAULT, RIGHT_MIN, rightMax, usePanels } from '../state/panels'
import { useProjects } from '../state/projects'
import { useSessions } from '../state/sessions'
import { useUi } from '../state/ui'
import { MAX_SESSIONS_PER_WORKSPACE } from '../../shared/limits'
import type { RepoScriptsInfo, WorkspaceState } from '../../shared/ipc-contract'

const RUN_GLYPHS = new Map([
  ['play', '▶'],
  ['terminal', '❯_'],
  ['code', '‹›'],
  ['hammer', '⚒'],
  ['flask-conical', '⚗'],
  ['test-tube', '⚗'],
  ['globe', '◎'],
  ['rocket', '↗'],
  ['zap', 'ϟ']
])

const RUN_DISABLED_TITLES: Record<Exclude<WorkspaceState, 'ready'>, string> = {
  initializing: 'Creating worktree — run actions are available when the workspace is ready',
  setting_up: 'Running setup script — run actions are available when the workspace is ready',
  error: 'Workspace setup failed — see the setup log before running actions'
}

export function Workspace({ workspaceId }: { workspaceId: string }) {
  const workspace = useProjects((s) =>
    Object.values(s.workspacesByProject)
      .flat()
      .find((w) => w.id === workspaceId)
  )
  const loadWorkspaces = useProjects((s) => s.loadWorkspaces)
  const activeId = useSessions((s) => s.activeSessionByWorkspace[workspaceId] ?? null)
  const events = useSessions((s) => (activeId ? s.eventsBySession[activeId] : undefined)) ?? []
  // Voice mode replaces the transcript only once there is a session to talk to.
  const voiceStage = useUi((s) => s.voiceMode) && !!activeId
  const load = useSessions((s) => s.load)
  const loadTree = useFiles((s) => s.loadTree)
  const openAt = useFiles((s) => s.openAt)
  const closeViewer = useFiles((s) => s.closeViewer)
  const openPath = useFiles((s) => s.openPathByWorkspace[workspaceId] ?? null)
  const viewerMode = useFiles((s) => s.viewerModeByWorkspace[workspaceId] ?? 'content')
  const rightW = usePanels((s) => s.rightW)
  const maxRight = usePanels(rightMax)
  const setRightW = usePanels((s) => s.setRightW)
  const leftHidden = usePanels((s) => s.leftHidden)
  const rightHidden = usePanels((s) => s.rightHidden)
  const setLeftHidden = usePanels((s) => s.setLeftHidden)
  const setRightHidden = usePanels((s) => s.setRightHidden)
  const push = useToasts((s) => s.push)
  const commitPanels = usePanels((s) => s.commit)
  const [pane, setPane] = useState<'chat' | 'viewer'>('chat')
  const [scripts, setScripts] = useState<{
    workspaceId: string
    actions: RepoScriptsInfo['actions']
  } | null>(null)

  const workspaceState = workspace?.state ?? 'initializing'
  const ready = workspaceState === 'ready'
  const actions = scripts?.workspaceId === workspaceId ? scripts.actions : []
  const projectId = workspace?.projectId

  useEffect(() => {
    void load(workspaceId)
  }, [workspaceId, load])

  useEffect(() => {
    if (ready) void loadTree(workspaceId)
  }, [workspaceId, ready, loadTree])

  // Pushes carry only state. Re-read persisted runtime metadata once per transition so a new
  // workspace's setup log becomes available without waiting for a project reload.
  useEffect(() => {
    if (projectId === undefined || workspaceState === 'initializing') return
    void loadWorkspaces(projectId).catch((err: unknown) =>
      push(`Could not refresh workspace details: ${String(err)}`, 'err')
    )
  }, [projectId, workspaceState, loadWorkspaces, push])

  // The store receives pushed bootstrap transitions. Refresh on navigation and readiness changes;
  // ignore a response from a previous workspace or bootstrap phase.
  useEffect(() => {
    let disposed = false
    window.loom.workspaces
      .scripts(workspaceId)
      .then((info) => {
        if (!disposed) setScripts({ workspaceId, actions: info.actions })
      })
      .catch((err: unknown) => {
        if (!disposed) push(`Could not load run actions: ${String(err)}`, 'err')
      })
    return () => {
      disposed = true
    }
  }, [workspaceId, ready, push])

  // Conductor-style: one pinned viewer tab, present only while a file is open; opening any file
  // activates it, selecting a session tab returns to the chat. Mode is in the deps so a diff
  // reopen of the already-open path still brings the viewer forward.
  useEffect(() => {
    setPane(openPath !== null ? 'viewer' : 'chat')
  }, [openPath, viewerMode])

  // ⌘T mirrors the tab strip's +: a fresh compose tab, chat pane in front of the viewer.
  // Same guards as the button: never past the per-workspace cap, never while already drafting.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 't' || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      const store = useSessions.getState()
      const rows = store.sessionsByWorkspace[workspaceId] ?? []
      const active = store.activeSessionByWorkspace[workspaceId] ?? null
      const drafting = active === '' || (active === null && rows.length === 0)
      if (drafting || rows.length >= MAX_SESSIONS_PER_WORKSPACE) return
      e.preventDefault()
      useUi.getState().openNewSession(workspaceId)
      setPane('chat')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workspaceId])
  useEffect(() => {
    setPane('chat')
  }, [activeId])

  return (
    <>
      <main className="main glass">
        <div className="topbar workspace-topbar">
          <button
            type="button"
            className="icon-btn workspace-pane-toggle"
            aria-pressed={leftHidden}
            title={leftHidden ? 'Show sidebar' : 'Hide sidebar'}
            aria-label={leftHidden ? 'Show sidebar' : 'Hide sidebar'}
            onClick={() => setLeftHidden(!leftHidden)}
          >
            ◧
          </button>
          <span className="grow">{workspace?.name ?? workspaceId}</span>
          <div className="row workspace-topbar-actions">
            {actions.length > 0 && (
              <div className="workspace-run-actions" role="group" aria-label="Run actions">
                {actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className="btn btn-ghost workspace-run-action"
                    data-default={action.isDefault}
                    disabled={!ready}
                    title={ready ? `Run ${action.id} in the terminal` : RUN_DISABLED_TITLES[workspaceState]}
                    onClick={() => {
                      window.loom.workspaces
                        .runAction(workspaceId, action.id)
                        .then(() => push(`Running ${action.id} in the terminal`))
                        .catch((err: unknown) => push(String(err), 'err'))
                    }}
                  >
                    <span className="workspace-run-glyph" aria-hidden="true">
                      {RUN_GLYPHS.get(action.icon?.toLowerCase() ?? '') ?? '▶'}
                    </span>
                    {action.id}
                  </button>
                ))}
              </div>
            )}
            <PrStatus workspaceId={workspaceId} ready={ready} />
          </div>
          <button
            type="button"
            className="icon-btn workspace-pane-toggle"
            aria-pressed={rightHidden}
            title={rightHidden ? 'Show side panel' : 'Hide side panel'}
            aria-label={rightHidden ? 'Show side panel' : 'Hide side panel'}
            onClick={() => setRightHidden(!rightHidden)}
          >
            ◨
          </button>
        </div>
        {!ready && (
          <div
            className="workspace-bootstrap-status"
            data-state={workspaceState}
            role="status"
            title={workspaceState === 'error' ? 'Workspace setup failed — see the setup log' : undefined}
          >
            {workspaceState === 'initializing' ? (
              'Creating worktree…'
            ) : (
              <>
                <span className="workspace-bootstrap-label">Setting up workspace… setup log:</span>
                {workspace?.setupLogPath ? (
                  <span className="workspace-setup-log" title={workspace.setupLogPath}>
                    {workspace.setupLogPath}
                  </span>
                ) : (
                  'unavailable'
                )}
              </>
            )}
          </div>
        )}
        <div className="tabs-row">
          {openPath !== null && (
            // The wrapper carries the tab chrome so the close button is a sibling, as on session tabs.
            <div className={`tab tab-pin${pane === 'viewer' ? ' tab-on' : ''}`} role="presentation">
              <button
                type="button"
                aria-pressed={pane === 'viewer'}
                className="tab-main"
                title={openPath}
                onClick={() => setPane('viewer')}
              >
                <span className="tab-label">{openPath.split('/').pop() ?? openPath}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label="Close file viewer"
                title="Close file"
                onClick={() => {
                  closeViewer(workspaceId)
                  setPane('chat')
                }}
              >
                ×
              </button>
            </div>
          )}
          <SessionTabs
            workspaceId={workspaceId}
            chatShown={pane === 'chat'}
            onSelect={() => setPane('chat')}
          />
        </div>
        {pane === 'viewer' && openPath !== null ? (
          <ViewerHost workspaceId={workspaceId} />
        ) : (
          <>
            {!voiceStage && (
              <MessageList
                sessionId={activeId || undefined}
                events={events}
                onFileOpen={(path, line) => void openAt(workspaceId, path, line)}
                onPrompt={(text) => useUi.getState().setDraft(text)}
              />
            )}
            <Composer
              workspaceId={workspaceId}
              sessionId={activeId === '' ? null : activeId}
              disabled={!ready}
            />
          </>
        )}
      </main>
      {/* Always mounted: the shell collapses this column to a 0px track when hidden,
          which is what lets the grid transition animate instead of snapping. */}
      <Splitter
        label="Resize side panel"
        panel="after"
        value={rightW}
        min={RIGHT_MIN}
        max={maxRight}
        defaultValue={RIGHT_DEFAULT}
        onChange={setRightW}
        onCommit={commitPanels}
      />
      <section className="rightpane glass">
        {ready && (
          <>
            <FileTree workspaceId={workspaceId} />
            <XtermPane workspaceId={workspaceId} />
          </>
        )}
      </section>
    </>
  )
}
