import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SessionRow } from '../../../shared/ipc-contract'
import { MAX_SESSIONS_PER_WORKSPACE } from '../../../shared/limits'
import type { Effort } from '../../../shared/models'
import { useSessions } from '../../state/sessions'
import { SessionActivityIndicator } from '../ui/SessionActivityIndicator'
import { useUi } from '../../state/ui'
import { Popover } from '../ui/Popover'
import { useToasts } from '../ui/Toast'
import { RecentChats } from './RecentChats'
import { SessionInstructions } from './SessionInstructions'
import { clampInWindow } from '../ui/anchor'
import './flow.css'

/**
 * Session tabs, same attached family as the pinned viewer tab. While the viewer
 * is showing, no session tab reads as selected; clicking any tab (including the
 * current one) returns to the chat via onSelect. An empty-string active id is
 * the compose sentinel and renders as a draft "New session" tab. Each session
 * tab carries a close button (hover or keyboard focus), which closes the session
 * without confirmation; the worktree is untouched. Right-click, Shift+F10 or the
 * menu key on a session tab opens its Instructions / Export / Fork / Close menu.
 */
export function SessionTabs({
  workspaceId,
  chatShown,
  onSelect
}: {
  workspaceId: string
  chatShown: boolean
  onSelect: () => void
}) {
  const sessions = useSessions((s) => s.sessionsByWorkspace[workspaceId]) ?? []
  const running = useSessions((s) => s.activity.bySession)
  const unread = useSessions((s) => s.unreadBySession)
  const activeId = useSessions((s) => s.activeSessionByWorkspace[workspaceId] ?? null)
  const setActive = useSessions((s) => s.setActive)
  const closeSession = useSessions((s) => s.close)
  const push = useToasts((s) => s.push)
  const openNewSession = useUi((s) => s.openNewSession)
  const atCap = sessions.length >= MAX_SESSIONS_PER_WORKSPACE
  const drafting = activeId === '' || (activeId === null && sessions.length === 0)
  const [menu, setMenu] = useState<{ session: SessionRow; x: number; y: number } | null>(null)
  const [instructionsSession, setInstructionsSession] = useState<SessionRow | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    tabsRef.current?.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest'
    })
  }, [activeId, chatShown, sessions])
  const closeMenu = useCallback(() => setMenu(null), [])
  const closeInstructions = useCallback(() => setInstructionsSession(null), [])

  function closeTab(session: SessionRow) {
    closeSession(workspaceId, session.id)
      .then(() => useUi.getState().saveComposeDraft(session.id, ''))
      .catch((err: unknown) => push(`Could not close session: ${String(err)}`, 'err'))
  }

  function exportTab(session: SessionRow) {
    window.loom.sessions
      .exportMarkdown(session.id)
      .then((path) => {
        if (path !== null) push(`Exported to ${path}`)
      })
      .catch((err: unknown) => push(`Export failed: ${String(err)}`, 'err'))
  }

  function forkTab(session: SessionRow) {
    window.loom.sessions
      .fork({
        workspaceId,
        backend: session.backend,
        model: session.model,
        effort: session.effort as Effort,
        sourceSessionId: session.id
      })
      .then(async (row) => {
        await useSessions.getState().load(workspaceId)
        useSessions.getState().setActive(workspaceId, row.id)
        push('Forked session')
      })
      .catch((err: unknown) => push(`Fork failed: ${String(err)}`, 'err'))
  }

  return (
    <div ref={tabsRef} className="tabs session-tabs" role="tablist" aria-label="Sessions">
      {sessions.map((session) => {
        const on = chatShown && session.id === activeId
        const isRunning = running[session.id] !== undefined
        const hasLogo = session.backend === 'claude' || session.backend === 'codex'
        return (
          // The wrapper carries the tab chrome so the close button is a sibling, not a nested button.
          <div
            key={session.id}
            className={`tab session-tab${on ? ' tab-on' : ''}`}
            data-unread={(unread[session.id]?.seq ?? 0) > 0}
            role="presentation"
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ session, x: e.clientX, y: e.clientY })
            }}
          >
            <button
              role="tab"
              aria-selected={on}
              aria-label={`${session.title}${unread[session.id]?.seq ? ' (unread messages)' : ''}`}
              aria-haspopup="menu"
              className="tab-main"
              title={`${session.backend} · ${session.model} · ${session.effort}`}
              onClick={() => {
                setActive(workspaceId, session.id)
                onSelect()
              }}
              onKeyDown={(e) => {
                if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return
                // Also suppresses the contextmenu event the key would fire, so the menu opens once.
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                setMenu({ session, x: rect.left, y: rect.bottom })
              }}
            >
              {isRunning && !hasLogo ? (
                <SessionActivityIndicator />
              ) : (
                <span
                  className="tab-backend-mark"
                  data-backend={session.backend}
                  data-running={isRunning}
                  role={isRunning ? 'img' : undefined}
                  aria-label={isRunning ? 'Session running' : undefined}
                  aria-hidden={isRunning ? undefined : true}
                  title={isRunning ? 'Session running' : undefined}
                />
              )}
              <span className="tab-label">{session.title}</span>
            </button>
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${session.title}`}
              title="Close session"
              onClick={() => closeTab(session)}
            >
              ×
            </button>
          </div>
        )
      })}
      {drafting && (
        <button
          role="tab"
          aria-selected={chatShown}
          className={`tab tab-draft${chatShown ? ' tab-on' : ''}`}
          onClick={onSelect}
        >
          <span className="tab-label">New session</span>
        </button>
      )}
      <button
        className="tab tab-add"
        title={atCap ? 'Session limit reached' : 'New session'}
        aria-label="New session"
        disabled={atCap || drafting}
        onClick={() => {
          openNewSession(workspaceId)
          onSelect()
        }}
      >
        +
      </button>
      <RecentChats key={workspaceId} workspaceId={workspaceId} atCap={atCap} onSelect={onSelect} />
      {menu !== null && (
        <TabMenu key={`${menu.session.id}:${menu.x}:${menu.y}`} x={menu.x} y={menu.y} onClose={closeMenu}>
          {(
            [
              ['View instructions', setInstructionsSession],
              ['Export as Markdown', exportTab],
              ['Fork session', forkTab],
              ['Close session', closeTab]
            ] as const
          ).map(([label, run]) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              className="list-option popover-item"
              onClick={() => {
                closeMenu()
                run(menu.session)
              }}
            >
              {label}
            </button>
          ))}
        </TabMenu>
      )}
      {instructionsSession !== null && (
        <SessionInstructions
          key={instructionsSession.id}
          sessionId={instructionsSession.id}
          onClose={closeInstructions}
        />
      )}
    </div>
  )
}

/**
 * Popover pinned at a viewport point. It is measured before paint and nudged back inside the
 * window, so a menu opened near the right or bottom edge never renders off-screen.
 */
function TabMenu({
  x,
  y,
  onClose,
  children
}: {
  x: number
  y: number
  onClose: () => void
  children: ReactNode
}) {
  const anchorRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const menu = anchor?.querySelector('.popover')
    if (anchor === null || menu === null || menu === undefined) return
    const { width, height } = menu.getBoundingClientRect()
    anchor.style.left = `${clampInWindow(x, width, window.innerWidth)}px`
    anchor.style.top = `${clampInWindow(y, height, window.innerHeight)}px`
  }, [x, y])

  return createPortal(
    <div ref={anchorRef} className="popover-wrap session-tab-menu-anchor" style={{ left: x, top: y }}>
      <Popover open onClose={onClose} className="session-tab-menu">
        {children}
      </Popover>
    </div>,
    document.body
  )
}
