import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SessionRow } from '../../../shared/ipc-contract'
import { useSessions } from '../../state/sessions'
import { Popover } from '../ui/Popover'
import { relativeTime } from '../ui/relativeTime'
import { useToasts } from '../ui/Toast'
import { clampInWindow } from '../ui/anchor'

/** Portalled out of the scrolling tab strip so the anchored menu is never clipped. */
export function RecentChats({
  workspaceId,
  atCap,
  onSelect
}: {
  workspaceId: string
  atCap: boolean
  onSelect: () => void
}) {
  const [open, setOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [reopening, setReopening] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0, maxHeight: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const pendingRef = useRef(false)
  const reopen = useSessions((s) => s.reopen)
  const push = useToasts((s) => s.push)
  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current
    if (trigger === null) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(360, window.innerWidth - 32)
    const top = rect.bottom + 8
    setPosition({
      top,
      left: clampInWindow(rect.left, width, window.innerWidth, 16),
      maxHeight: Math.max(0, window.innerHeight - top - 16)
    })
  }, [])

  useEffect(() => {
    if (!open) return
    let active = true
    window.loom.sessions.closed(workspaceId).then(
      (rows) => {
        if (active) setSessions(rows.slice(0, 10))
      },
      (err: unknown) => {
        if (!active) return
        close()
        push(`Could not load recent chats: ${String(err)}`, 'err')
      }
    )
    window.addEventListener('resize', positionMenu)
    // Capture also sees horizontal scrolling within the tab strip.
    document.addEventListener('scroll', positionMenu, true)
    return () => {
      active = false
      window.removeEventListener('resize', positionMenu)
      document.removeEventListener('scroll', positionMenu, true)
    }
  }, [open, workspaceId, close, positionMenu, push])

  useEffect(() => {
    if (!open || atCap || reopening) return
    // Popover's initial autofocus can precede the IPC response. Hand focus to the
    // first row when it arrives, without stealing it from another menu item.
    if (document.activeElement === triggerRef.current || document.activeElement === document.body) {
      firstItemRef.current?.focus()
    }
  }, [open, sessions, atCap, reopening])

  async function reopenSession(id: string) {
    if (atCap || pendingRef.current) return
    pendingRef.current = true
    setReopening(true)
    try {
      await reopen(workspaceId, id)
      onSelect()
      close()
    } catch (err) {
      push(`Could not reopen session: ${String(err)}`, 'err')
    } finally {
      pendingRef.current = false
      setReopening(false)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="tab tab-add tab-history"
        aria-label="Recent chats"
        title="Reopen a closed session"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close()
            return
          }
          setSessions(null)
          positionMenu()
          setOpen(true)
        }}
      >
        <svg
          className="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M3 11a9 9 0 1 1 2.6 7.4M3 5v6h6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div className="popover-wrap recent-chats-anchor" style={position} aria-busy={reopening}>
            <Popover open={open} onClose={close} anchorRef={triggerRef} className="recent-chats">
              <div className="recent-chats-head" role="presentation">
                Recent chats
              </div>
              <div className="recent-chats-list" role="presentation">
                {sessions === null ? (
                  <div className="recent-chats-empty" role="status">
                    Loading recent chats…
                  </div>
                ) : sessions.length === 0 ? (
                  <div className="recent-chats-empty">No closed sessions yet.</div>
                ) : (
                  sessions.map((session, index) => (
                    <button
                      key={session.id}
                      ref={index === 0 ? firstItemRef : undefined}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="list-option popover-item recent-chats-row"
                      disabled={atCap || reopening}
                      title={atCap ? 'Session limit reached' : session.title}
                      onClick={() => void reopenSession(session.id)}
                    >
                      <span className="recent-chats-copy">
                        <span className="recent-chats-title">{session.title}</span>
                        <span className="recent-chats-model">
                          {session.backend} · {session.model}
                        </span>
                      </span>
                      <span className="recent-chats-time">
                        {relativeTime(session.closedAt ?? Date.now())}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </Popover>
          </div>,
          document.body
        )}
    </>
  )
}
