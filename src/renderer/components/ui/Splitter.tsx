import { useRef, useState } from 'react'

const STEP = 16
const BIG_STEP = 64

/**
 * Drag handle between two panels, resizing the one on `panel`'s side. `axis="x"` (default) sits
 * between columns and resizes a width; `axis="y"` sits between stacked rows and resizes a height.
 * The size is derived from the pointer's offset since drag start, so the handle stays under the
 * cursor even after hitting a clamp. Pointer capture keeps the drag alive over the
 * terminal/iframes; persistence happens once on release.
 * Keyboard: arrows along the axis nudge 16px (shift 64), Home/End jump to the limits, Enter or
 * double-click restores the default.
 */
export function Splitter({
  label,
  axis = 'x',
  panel,
  value,
  min,
  max,
  defaultValue,
  onChange,
  onCommit
}: {
  label: string
  axis?: 'x' | 'y'
  /** Which side of the handle the resized panel sits on. */
  panel: 'before' | 'after'
  value: number
  min: number
  max: number
  defaultValue: number
  onChange: (size: number) => void
  onCommit: () => void
}) {
  const start = useRef<{ at: number; size: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const dir = panel === 'before' ? 1 : -1
  const y = axis === 'y'
  const [decrease, increase] = y ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight']
  // max is live (it shrinks so the center column keeps its minimum), so every write is bounded here too.
  const change = (w: number) => onChange(Math.min(max, Math.max(min, w)))

  function end() {
    if (start.current === null) return
    start.current = null
    setDragging(false)
    document.body.classList.remove('is-resizing', 'is-resizing-y')
    onCommit()
  }

  return (
    <div
      className={y ? 'splitter splitter-y' : 'splitter'}
      role="separator"
      aria-orientation={y ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={dragging}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { at: y ? e.clientY : e.clientX, size: value }
        setDragging(true)
        document.body.classList.add('is-resizing')
        if (y) document.body.classList.add('is-resizing-y')
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (s !== null) change(s.size + ((y ? e.clientY : e.clientX) - s.at) * dir)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => {
        change(defaultValue)
        onCommit()
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? BIG_STEP : STEP
        let next: number | null = null
        if (e.key === decrease) next = value - step * dir
        else if (e.key === increase) next = value + step * dir
        else if (e.key === 'Home') next = min
        else if (e.key === 'End') next = max
        else if (e.key === 'Enter') next = defaultValue
        if (next === null) return
        e.preventDefault()
        change(next)
        onCommit()
      }}
    />
  )
}
