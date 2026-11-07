import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject
} from 'react'

const ITEMS = '[role="menuitem"]:not(:disabled)'

/**
 * Anchored menu; the parent wrapper must carry `popover-wrap`. Children are `role="menuitem"`
 * buttons: the first takes focus on open, arrows/Home/End move between them, Escape and Tab
 * close, and focus returns to whatever opened it.
 */
export function Popover({
  open,
  onClose,
  children,
  align = 'left',
  className,
  anchorRef
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  align?: 'left' | 'right'
  className?: string
  /** The trigger: presses on it toggle the menu themselves, so they are not outside clicks. */
  anchorRef?: RefObject<HTMLElement | null>
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (anchorRef?.current?.contains(target) === true) return
      if (ref.current && !ref.current.contains(target)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Capture phase + stop: an enclosing Modal's Escape listener must not close it too.
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, anchorRef])

  useEffect(() => {
    if (!open) return
    let opener: Element | null = null
    // Deferred a frame: an enclosing Modal autofocuses after its children's effects have run.
    const frame = requestAnimationFrame(() => {
      opener = document.activeElement
      ref.current?.querySelector<HTMLElement>(ITEMS)?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      const lost = document.activeElement === null || document.activeElement === document.body
      if (lost && opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [open])

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Tab') {
      onClose()
      return
    }
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(ITEMS))
    if (items.length === 0) return
    const at = items.findIndex((el) => el === document.activeElement)
    const last = items.length - 1
    const targets: Record<string, number> = {
      ArrowDown: at >= last ? 0 : at + 1,
      ArrowUp: at <= 0 ? last : at - 1,
      Home: 0,
      End: last
    }
    const next = targets[e.key]
    if (next === undefined) return
    e.preventDefault()
    items[next]?.focus()
  }

  if (!open) return null
  return (
    <div
      ref={ref}
      className={`popover glass popover-${align}${className === undefined ? '' : ` ${className}`}`}
      role="menu"
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  )
}
