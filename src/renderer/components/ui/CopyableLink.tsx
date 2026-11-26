import { useEffect, useState, type ReactNode } from 'react'
import { ContextMenu } from './ContextMenu'
import { CopyIcon } from './icons'

/** Keep opening and copying separate, with the same actions in every text renderer. */
export function CopyableLink({
  value,
  onOpen,
  className,
  title,
  children,
  copyLabel = 'Copy link'
}: {
  value: string
  onOpen: () => void
  className: string
  title: string
  children: ReactNode
  copyLabel?: string
}) {
  const [status, setStatus] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (status === '') return
    const timer = setTimeout(() => setStatus(''), 2000)
    return () => clearTimeout(timer)
  }, [status])

  async function copy() {
    setMenu(null)
    setStatus('')
    try {
      await navigator.clipboard.writeText(value)
      setStatus('Copied')
    } catch {
      setStatus('Could not copy')
    }
  }

  return (
    <span
      className="copyable-link"
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <button type="button" className={className} title={title} onClick={onOpen}>
        {children}
      </button>
      <button
        type="button"
        className="icon-btn link-copy"
        data-state={status}
        aria-label={`${copyLabel}: ${value}`}
        title={status || `${copyLabel}: ${value}`}
        onClick={(event) => {
          event.stopPropagation()
          void copy()
        }}
      >
        {status === '' ? <CopyIcon /> : <span aria-hidden="true">{status === 'Copied' ? '✓' : '!'}</span>}
      </button>
      <span className="link-copy-status" role="status">
        {status}
      </span>
      {menu !== null && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            type="button"
            role="menuitem"
            className="list-option popover-item"
            onClick={() => void copy()}
          >
            {copyLabel}
          </button>
        </ContextMenu>
      )}
    </span>
  )
}
