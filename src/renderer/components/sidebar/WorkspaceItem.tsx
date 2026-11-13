import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { BranchPrState, CloudStatus, WorkspaceRow } from '../../../shared/ipc-contract'
import { useCloud } from '../../state/cloud'
import { useProjects } from '../../state/projects'
import { useSessions } from '../../state/sessions'
import { useUi } from '../../state/ui'
import { clampInWindow, topBelowOrAbove, useCloseOnAnchorMove } from '../ui/anchor'
import { BranchIcon, CloudIcon, MergedIcon, MoreIcon, PullRequestIcon } from '../ui/icons'
import { SessionActivityIndicator } from '../ui/SessionActivityIndicator'
import { Popover } from '../ui/Popover'
import { useToasts } from '../ui/Toast'
import { CheckpointsMenu } from './CheckpointsMenu'

/** Gap between trigger and menu. */
const GAP = 4

/**
 * Sidebar row actions menu, portalled to body so it floats over `.side-scroll` instead of
 * becoming part of its scrolling content. Right-aligned under the trigger (flipped above it when
 * there is no room below), clamped inside the window, and closed by Escape, an outside press,
 * a resize or any scroll that moves the trigger.
 */
export function RowMenu({
  anchorRef,
  onClose,
  className,
  children
}: {
  anchorRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  className?: string
  children: ReactNode
}) {
  const wrapRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const rect = anchorRef.current?.getBoundingClientRect()
    const menu = wrap?.querySelector('.popover')
    if (wrap === null || rect === undefined || menu === null || menu === undefined) return
    const { width, height } = menu.getBoundingClientRect()
    wrap.style.left = `${clampInWindow(rect.right - width, width, window.innerWidth)}px`
    wrap.style.top = `${clampInWindow(topBelowOrAbove(rect, height, GAP), height, window.innerHeight)}px`
  }, [anchorRef])

  useCloseOnAnchorMove(anchorRef, onClose)

  return createPortal(
    <div ref={wrapRef} className="popover-wrap row-menu-anchor">
      <Popover
        open
        onClose={onClose}
        anchorRef={anchorRef}
        className={`row-menu${className === undefined ? '' : ` ${className}`}`}
      >
        {children}
      </Popover>
    </div>,
    document.body
  )
}

/** What a cloud workspace's mark says: where it lives and, when it cannot be reached, why. */
const CLOUD_TITLES: Record<CloudStatus['state'], string> = {
  connected: 'Cloud workspace',
  connecting: 'Cloud workspace: connecting to the runner…',
  unreachable: 'Cloud workspace: the runner is unreachable',
  'signed-out': 'Cloud workspace: sign in to reach it',
  update: 'Cloud workspace: Loom and the runner are different versions',
  off: 'Cloud workspace: no runner is set'
}

/** One sidebar workspace row plus its hover/focus "⋯" actions and checkpoints. */
const PR_TITLES: Record<BranchPrState, string> = { open: 'Pull request open', merged: 'Pull request merged' }

export function WorkspaceItem({
  workspace,
  active,
  pr,
  onDelete
}: {
  workspace: WorkspaceRow
  active: boolean
  /** The PR on this workspace's branch, if GitHub reports one; undefined shows the plain branch. */
  pr?: BranchPrState | undefined
  onDelete: () => void
}) {
  const navigate = useUi((s) => s.navigate)
  const running = useSessions((s) => Object.values(s.activity.bySession).includes(workspace.id))
  const unread = useSessions((s) =>
    Object.values(s.unreadBySession).some((row) => row.workspaceId === workspace.id && row.seq > 0)
  )
  const GitIcon = pr === 'merged' ? MergedIcon : pr === 'open' ? PullRequestIcon : BranchIcon
  // A cloud workspace lives on the runner: with the connection down it cannot be asked anything.
  const cloudState = useCloud((s) => (workspace.cloud === true ? s.status.state : null))
  const unreachable = cloudState !== null && cloudState !== 'connected'
  const cloudTitle = CLOUD_TITLES[cloudState ?? 'connected']
  const setArchived = useProjects((s) => s.setArchived)
  const push = useToasts((s) => s.push)
  const [menu, setMenu] = useState(false)
  const [checkpointsOpen, setCheckpointsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeMenu = useCallback(() => {
    setMenu(false)
    setCheckpointsOpen(false)
    triggerRef.current?.focus()
  }, [])

  const open = () => navigate({ name: 'workspace', workspaceId: workspace.id })
  const statusTitle =
    workspace.state === 'initializing'
      ? 'Initializing workspace…'
      : workspace.state === 'setting_up'
        ? 'Running setup script…'
        : workspace.state === 'error'
          ? `Workspace setup failed — see the setup log${workspace.setupLogPath ? `: ${workspace.setupLogPath}` : ''}`
          : null

  function toggleArchived() {
    closeMenu()
    const next = !workspace.archived
    const verb = next ? 'archive' : 'unarchive'
    setArchived(workspace.id, next)
      .then(() => push(`${next ? 'Archived' : 'Unarchived'} ${workspace.name}`))
      .catch((err: unknown) => push(`Could not ${verb} ${workspace.name}: ${String(err)}`, 'err'))
  }

  return (
    <div
      className="ws-item"
      data-archived={workspace.archived}
      data-menu={menu}
      data-unreachable={unreachable}
    >
      <button
        type="button"
        className="ws-row"
        data-active={active}
        data-unread={unread}
        aria-current={active ? 'page' : undefined}
        onClick={open}
      >
        <span
          className="ws-icon"
          data-pr={pr}
          title={running ? 'Session running' : pr === undefined ? undefined : PR_TITLES[pr]}
        >
          {running ? <SessionActivityIndicator /> : <GitIcon />}
        </span>
        <span className="ws-name">{workspace.name}</span>
        {unread && (
          <span className="ws-unread-dot" role="img" aria-label="Unread messages" title="Unread messages" />
        )}
        <span className="ws-state-slot">
          {statusTitle !== null && (
            <span
              className={`ws-state-glyph${workspace.state === 'error' ? ' ws-state-error' : ' ws-state-spinner'}`}
              role="img"
              title={statusTitle}
              aria-label={statusTitle}
            />
          )}
        </span>
        {workspace.cloud === true && (
          <span className="ws-cloud" role="img" aria-label={cloudTitle} title={cloudTitle}>
            <CloudIcon />
          </span>
        )}
      </button>
      <div className="popover-wrap ws-more-wrap">
        <button
          ref={triggerRef}
          type="button"
          className="icon-btn ws-more"
          aria-label={`Actions for ${workspace.name}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          onClick={() => {
            if (menu) closeMenu()
            else setMenu(true)
          }}
        >
          <MoreIcon />
        </button>
        {menu && !checkpointsOpen && (
          <RowMenu anchorRef={triggerRef} onClose={closeMenu} className="ws-menu">
            <button
              type="button"
              role="menuitem"
              className="list-option popover-item"
              onClick={() => {
                closeMenu()
                open()
              }}
            >
              Open
            </button>
            <button
              type="button"
              role="menuitem"
              className="list-option popover-item"
              onClick={() => setCheckpointsOpen(true)}
            >
              Checkpoints…
            </button>
            <button
              type="button"
              role="menuitem"
              className="list-option popover-item"
              onClick={toggleArchived}
            >
              {workspace.archived ? 'Unarchive' : 'Archive'}
            </button>
            <div className="popover-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="list-option popover-item popover-item-danger"
              onClick={() => {
                closeMenu()
                onDelete()
              }}
            >
              Delete…
            </button>
          </RowMenu>
        )}
        {checkpointsOpen && (
          <CheckpointsMenu workspace={workspace} anchorRef={triggerRef} onClose={closeMenu} />
        )}
      </div>
    </div>
  )
}
