import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

export interface DropdownOption {
  value: string
  label: string
  /** Leading glyph in the list row (e.g. an action entry above the real options). */
  icon?: ReactNode
}

/** List max-height (240) + offset (6) + breathing room: below this, flip the list upward. */
const LIST_SPACE = 260

/**
 * Themed listbox replacing native <select>: the platform widget cannot carry
 * the app's dark glass theme, and the user mandated styled dropdowns everywhere.
 * Focus never leaves the trigger: options are tabIndex -1 and the active one is
 * announced through aria-activedescendant, so Tab moves past the control.
 */
export function Dropdown({
  value,
  options,
  onChange,
  placeholder = 'Select…'
}: {
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const baseId = useId()
  const listId = `${baseId}-list`
  const selected = options.findIndex((o) => o.value === value)
  const current = options[selected]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  /** The one open path for click and keyboard: place the list, then start on the selected option. */
  function show() {
    const rect = ref.current?.getBoundingClientRect()
    const below = rect === undefined ? Infinity : window.innerHeight - rect.bottom
    // Flip only when the list would overflow below and there is more room above.
    setUp(rect !== undefined && below < LIST_SPACE && rect.top > below)
    setActive(Math.max(selected, 0))
    setOpen(true)
  }

  function close(refocus: boolean) {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  function commit(index: number) {
    const option = options[index]
    if (option) onChange(option.value)
    close(true)
  }

  return (
    <div className="dropdown" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="dropdown-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && options[active] ? `${baseId}-opt-${active}` : undefined}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (!open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              show()
            }
            return
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => Math.min(i + 1, options.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Home') {
            e.preventDefault()
            setActive(0)
          } else if (e.key === 'End') {
            e.preventDefault()
            setActive(Math.max(options.length - 1, 0))
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            commit(active)
          } else if (e.key === 'Escape') {
            // Keep Escape inside the list; an enclosing Modal must not close too.
            e.stopPropagation()
            close(true)
          } else if (e.key === 'Tab') {
            close(false)
          }
        }}
      >
        <span className="grow">{current?.label ?? placeholder}</span>
        <span className="dropdown-caret" aria-hidden="true" />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          className={`dropdown-list elevated${up ? ' dropdown-up' : ''}`}
          role="listbox"
        >
          {options.map((option, index) => (
            <li key={option.value} role="none">
              <button
                id={`${baseId}-opt-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={option.value === value}
                className="list-option dropdown-item"
                data-index={index}
                data-active={index === active}
                data-on={option.value === value}
                onMouseEnter={() => setActive(index)}
                // Keep focus on the trigger so aria-activedescendant stays the single focus model.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(index)}
              >
                {option.icon}
                <span className="grow">{option.label}</span>
                {option.value === value && <span className="dropdown-check">✓</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
