import { useEffect, type RefObject } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]'
].join(', ')
const TEXT_ENTRY = 'input, textarea, [contenteditable="true"]'
const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])

let lastOutsideOverlay: HTMLElement | null = null
let installed = false

/**
 * Tracks input modality on <body data-modality> so text fields can show a focus ring for
 * keyboard users only (tokens.css), and remembers the last element focused outside any
 * overlay so a closing overlay can hand focus back to it.
 */
export function installFocusTracking(): void {
  if (installed) return
  installed = true
  window.addEventListener(
    'keydown',
    (e) => {
      // Arrows inside a text field move the caret; they do not signal keyboard navigation.
      const inField = e.target instanceof Element && e.target.closest(TEXT_ENTRY) !== null
      if (e.key === 'Tab' || (NAV_KEYS.has(e.key) && !inField)) document.body.dataset.modality = 'keyboard'
    },
    true
  )
  window.addEventListener('pointerdown', () => delete document.body.dataset.modality, true)
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('.overlay') === null)
      lastOutsideOverlay = e.target
  })
}

function tabbable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0
  )
}

/**
 * While active, Tab and Shift+Tab cycle inside the container; on deactivation focus
 * returns to whatever was focused before the overlay opened (if it still exists).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return
    // Opened from inside another overlay (a nested modal): hand focus back there, not behind both.
    const opener = document.activeElement
    const restore =
      opener instanceof HTMLElement && opener.closest('.overlay') !== null ? opener : lastOutsideOverlay
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current
      if (e.key !== 'Tab' || root === null) return
      // Only the topmost overlay traps Tab; a modal beneath a nested one stands down.
      const overlays = document.querySelectorAll('.overlay')
      const top = overlays[overlays.length - 1]
      if (top !== undefined && !top.contains(root)) return
      const items = tabbable(root)
      const first = items[0]
      const last = items[items.length - 1]
      if (first === undefined || last === undefined) {
        e.preventDefault()
        return
      }
      const current = document.activeElement
      const inside = current instanceof Node && root.contains(current)
      if (e.shiftKey && (!inside || current === first)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (!inside || current === last)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (restore?.isConnected === true) restore.focus()
    }
  }, [ref, active])
}
