import { useEffect, useRef, type ReactNode } from 'react'
import { useFocusTrap } from './focus'

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  head,
  className,
  width = 460
}: {
  open: boolean
  /** Visible title, or only the accessible name when `head` replaces the header row. */
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Custom header row content (no title text or ✕; Escape and the overlay still close). */
  head?: ReactNode
  className?: string
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Declared before the autofocus effect so focus is restored to the opener only after this closes.
  useFocusTrap(ref, open)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // An explicit [data-autofocus] wins; else the first field, never the ✕ close button.
    const root = ref.current
    const target =
      root?.querySelector<HTMLElement>('[data-autofocus]') ??
      root?.querySelector<HTMLElement>('input, textarea, select') ??
      root?.querySelector<HTMLElement>('button:not([aria-label="Close"])')
    target?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        className={`modal glass${className === undefined ? '' : ` ${className}`}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
      >
        <div className="modal-head">
          {head ?? (
            <>
              <span className="modal-title grow">{title}</span>
              <button className="icon-btn" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer !== undefined && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}
