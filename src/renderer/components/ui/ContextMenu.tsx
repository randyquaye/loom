import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Popover } from './Popover'
import { clampInWindow } from './anchor'

/** Existing popover behavior, positioned at the click and kept inside the window. */
export function ContextMenu({
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
    <div ref={anchorRef} className="popover-wrap context-menu-anchor" style={{ left: x, top: y }}>
      <Popover open onClose={onClose} className="context-menu">
        {children}
      </Popover>
    </div>,
    document.body
  )
}
