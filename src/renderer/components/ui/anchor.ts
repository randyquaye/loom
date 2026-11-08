import { useEffect, type RefObject } from 'react'

/** Minimum inset from the window edge for menus pinned to a trigger. */
export const WINDOW_EDGE = 8

/** A menu's start coordinate on one axis, clamped so its whole extent stays inside the window. */
export function clampInWindow(start: number, size: number, viewport: number, edge = WINDOW_EDGE): number {
  return Math.max(edge, Math.min(start, viewport - size - edge))
}

/** Top of a menu under its trigger, flipped above it when the window's bottom edge would cut it. */
export function topBelowOrAbove(trigger: DOMRect, height: number, gap: number, edge = WINDOW_EDGE): number {
  const below = trigger.bottom + gap
  return below + height + edge > window.innerHeight ? trigger.top - gap - height : below
}

/**
 * Closes a portalled menu when the window resizes or a scroll moves its trigger. Scrolls
 * elsewhere (a streaming transcript, say) leave it open.
 */
export function useCloseOnAnchorMove(
  anchorRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true
): void {
  useEffect(() => {
    if (!enabled) return
    const onScroll = (e: Event) => {
      const anchor = anchorRef.current
      if (anchor !== null && e.target instanceof Node && e.target.contains(anchor)) onClose()
    }
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [anchorRef, onClose, enabled])
}
