import { create } from 'zustand'

const SIDEBAR_KEY = 'loom.panel.sidebar.v2'
const RIGHT_KEY = 'loom.panel.right.v2'
const LEFT_HIDDEN_KEY = 'loom.panel.leftHidden.v1'
const RIGHT_HIDDEN_KEY = 'loom.panel.rightHidden.v1'
const TERM_KEY = 'loom.panel.term.v1'
const TERM_COLLAPSED_KEY = 'loom.panel.termCollapsed.v1'

export const SIDEBAR_MIN = 208
export const SIDEBAR_MAX = 448
export const SIDEBAR_DEFAULT = 304
export const RIGHT_MIN = 280
export const RIGHT_MAX = 600
export const RIGHT_DEFAULT = 442
export const TERM_MIN = 120
export const TERM_DEFAULT = 260
/** The file tree keeps at least this much of the right pane above the terminal. */
export const TREE_MIN = 160
/** The chat/viewer column never resizes below this while the window can afford it. */
export const CENTER_MIN = 480
/** The shell is full-bleed; only splitter columns consume horizontal space. */
const SHELL_PADDING = 0
const SPLITTER_W = 8

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function stored(key: string, fallback: number, min: number, max: number): number {
  const raw = localStorage.getItem(key)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? clamp(Math.round(n), min, max) : fallback
}

function storedFlag(key: string): boolean {
  return localStorage.getItem(key) === '1'
}

/** Width a side panel may take once the other panel and the center minimum are paid for. */
function room(viewportW: number, other: number, withRight: boolean): number {
  const splitters = withRight ? 2 * SPLITTER_W : SPLITTER_W
  return viewportW - SHELL_PADDING - splitters - CENTER_MIN - other
}

/** Effective sidebar max; never below the min, so a tiny window squeezes the center instead. */
export function sidebarMax(s: { viewportW: number; rightW: number; withRight: boolean }): number {
  const limit = room(s.viewportW, s.withRight ? s.rightW : 0, s.withRight)
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, limit))
}

export function rightMax(s: { viewportW: number; sidebarW: number }): number {
  return Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, room(s.viewportW, s.sidebarW, true)))
}

/** Effective terminal height max: the right pane less the tree minimum and the row splitter. */
export function termMax(s: { paneH: number }): number {
  return Math.max(TERM_MIN, s.paneH - TREE_MIN - SPLITTER_W)
}

interface PanelsState {
  sidebarW: number
  rightW: number
  viewportW: number
  /** Whether the right pane is in the grid (workspace route only). */
  withRight: boolean
  setSidebarW(w: number): void
  setRightW(w: number): void
  setWithRight(on: boolean): void
  /** Sidebar / side-panel visibility on workspace routes, persisted per machine. */
  leftHidden: boolean
  rightHidden: boolean
  setLeftHidden(on: boolean): void
  setRightHidden(on: boolean): void
  /** Terminal height inside the right pane, including its tab bar. */
  termH: number
  /** Right pane height, measured by the terminal panel; bounds `termH`. */
  paneH: number
  termCollapsed: boolean
  setTermH(h: number): void
  setPaneH(h: number): void
  setTermCollapsed(on: boolean): void
  /** Re-clamp sizes against the current window width and pane height; called on resize. */
  fit(): void
  /** Write sizes to disk; called once when a drag or key nudge ends, not per frame. */
  commit(): void
}

/** Shell column widths and the terminal height, persisted per machine and clamped on read and write. */
export const usePanels = create<PanelsState>((set, get) => ({
  sidebarW: stored(SIDEBAR_KEY, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
  rightW: stored(RIGHT_KEY, RIGHT_DEFAULT, RIGHT_MIN, RIGHT_MAX),
  viewportW: window.innerWidth,
  withRight: false,
  leftHidden: storedFlag(LEFT_HIDDEN_KEY),
  rightHidden: storedFlag(RIGHT_HIDDEN_KEY),
  // The pane is shorter than the window, so this only bounds the read until it is measured.
  termH: stored(TERM_KEY, TERM_DEFAULT, TERM_MIN, Math.max(TERM_MIN, window.innerHeight)),
  paneH: window.innerHeight,
  termCollapsed: storedFlag(TERM_COLLAPSED_KEY),
  setSidebarW: (w) => set({ sidebarW: clamp(Math.round(w), SIDEBAR_MIN, sidebarMax(get())) }),
  setRightW: (w) => set({ rightW: clamp(Math.round(w), RIGHT_MIN, rightMax(get())) }),
  setWithRight: (withRight) => {
    if (withRight === get().withRight) return
    set({ withRight })
    get().fit()
  },
  setLeftHidden: (on) => {
    set({ leftHidden: on })
    localStorage.setItem(LEFT_HIDDEN_KEY, on ? '1' : '0')
    get().fit()
  },
  setRightHidden: (on) => {
    set({ rightHidden: on })
    localStorage.setItem(RIGHT_HIDDEN_KEY, on ? '1' : '0')
    get().fit()
  },
  setTermH: (h) => set({ termH: clamp(Math.round(h), TERM_MIN, termMax(get())) }),
  setPaneH: (h) => {
    if (h <= 0 || h === get().paneH) return
    set({ paneH: h })
    get().fit()
  },
  setTermCollapsed: (on) => {
    set({ termCollapsed: on })
    localStorage.setItem(TERM_COLLAPSED_KEY, on ? '1' : '0')
  },
  fit: () => {
    const viewportW = window.innerWidth
    const s = { ...get(), viewportW }
    // The right pane gives way first; the sidebar keeps the navigation readable.
    const rightW = s.withRight ? clamp(s.rightW, RIGHT_MIN, rightMax(s)) : s.rightW
    const sidebarW = clamp(s.sidebarW, SIDEBAR_MIN, sidebarMax({ ...s, rightW }))
    const termH = clamp(s.termH, TERM_MIN, termMax(s))
    const prev = get()
    if (
      viewportW !== prev.viewportW ||
      rightW !== prev.rightW ||
      sidebarW !== prev.sidebarW ||
      termH !== prev.termH
    ) {
      set({ viewportW, rightW, sidebarW, termH })
    }
  },
  commit: () => {
    get().fit()
    localStorage.setItem(SIDEBAR_KEY, String(get().sidebarW))
    localStorage.setItem(RIGHT_KEY, String(get().rightW))
    localStorage.setItem(TERM_KEY, String(get().termH))
  }
}))

window.addEventListener('resize', () => usePanels.getState().fit())
usePanels.getState().fit()
