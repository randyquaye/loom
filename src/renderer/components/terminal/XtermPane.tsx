import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalInfo } from '../../../shared/ipc-contract'
import { Splitter } from '../ui/Splitter'
import { useToasts } from '../ui/Toast'
import { TERM_DEFAULT, TERM_MIN, termMax, usePanels } from '../../state/panels'
import { useProjects } from '../../state/projects'
import { clampInWindow, WINDOW_EDGE } from '../ui/anchor'
import '../panels/panels.css'

interface Tab {
  key: number
  label: string
  /** A terminal already running on the runner: the tab shows it instead of starting one. */
  attach?: TerminalInfo
}

const FIRST_TAB: Tab = { key: 1, label: 'shell 1' }

const LABEL_MAX = 24

/**
 * Tabbed terminal pane for one workspace, with a row splitter above it that sets its height and
 * a toggle that collapses it to the tab bar. Every tab owns a live PTY and xterm instance for its
 * whole lifetime; inactive and collapsed tabs stay mounted but hidden. Switching `workspaceId`
 * tears down every tab and starts over with a single shell.
 *
 * A cloud workspace's terminals live on the runner and outlive this pane: opening it shows
 * the ones already running, leaving it only stops watching, and closing a tab is what ends one.
 */
export function XtermPane({ workspaceId }: { workspaceId: string }) {
  return <TerminalTabs key={workspaceId} workspaceId={workspaceId} />
}

function TerminalTabs({ workspaceId }: { workspaceId: string }) {
  const baseId = useId()
  const push = useToasts((s) => s.push)
  // Labels keep counting up so `shell 2` stays `shell 2` after `shell 1` closes.
  const nextKey = useRef(2)
  const cloud = useProjects((s) =>
    Object.values(s.workspacesByProject).some((rows) =>
      rows.some((row) => row.id === workspaceId && row.cloud === true)
    )
  )
  // A cloud pane has no tabs until it knows which terminals are already running.
  const [tabs, setTabs] = useState<Tab[]>(cloud ? [] : [FIRST_TAB])
  const [activeKey, setActiveKey] = useState(1)
  const terms = useRef(new Map<number, Terminal>())
  const ptyIds = useRef(new Map<number, string>())
  const [withSelection, setWithSelection] = useState<ReadonlySet<number>>(new Set())
  const [labels, setLabels] = useState<ReadonlyMap<number, string>>(new Map())
  const [renaming, setRenaming] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const termH = usePanels((s) => s.termH)
  const maxTerm = usePanels(termMax)
  const setTermH = usePanels((s) => s.setTermH)
  const setPaneH = usePanels((s) => s.setPaneH)
  const collapsed = usePanels((s) => s.termCollapsed)
  const setCollapsed = usePanels((s) => s.setTermCollapsed)
  const commitPanels = usePanels((s) => s.commit)

  // The right pane's height bounds the terminal's; the store re-clamps it whenever this changes.
  useEffect(() => {
    const pane = panelRef.current?.parentElement
    if (pane === null || pane === undefined) return
    const measure = () => setPaneH(pane.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [setPaneH])

  useEffect(() => {
    if (!cloud) return
    let stale = false
    void window.loom.terminal
      .list(workspaceId)
      .catch((): TerminalInfo[] => [])
      .then((running) => {
        if (stale) return
        nextKey.current = Math.max(running.length, 1) + 1
        setTabs(
          running.length === 0
            ? [FIRST_TAB]
            : running.map((attach, index) => ({ key: index + 1, label: `shell ${index + 1}`, attach }))
        )
      })
    return () => {
      stale = true
    }
  }, [cloud, workspaceId])

  const trackPty = useCallback((key: number, id: string | null) => {
    if (id === null) ptyIds.current.delete(key)
    else ptyIds.current.set(key, id)
  }, [])

  const register = useCallback((key: number, term: Terminal | null) => {
    if (term) terms.current.set(key, term)
    else terms.current.delete(key)
  }, [])

  const selectionChanged = useCallback((key: number, has: boolean) => {
    setWithSelection((prev) => {
      if (prev.has(key) === has) return prev
      const next = new Set(prev)
      if (has) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  function addTab() {
    const key = nextKey.current++
    setTabs((prev) => [...prev, { key, label: `shell ${key}` }])
    setActiveKey(key)
  }

  function closeTab(key: number) {
    if (tabs.length <= 1) return
    // The runner keeps a cloud terminal until it is told to end it; closing its tab is that.
    const ptyId = ptyIds.current.get(key)
    if (cloud && ptyId !== undefined) void window.loom.terminal.destroy(ptyId)
    const index = tabs.findIndex((t) => t.key === key)
    const remaining = tabs.filter((t) => t.key !== key)
    if (key === activeKey) {
      const neighbour = remaining[index - 1] ?? remaining[0]
      if (neighbour) setActiveKey(neighbour.key)
    }
    setTabs(remaining)
    selectionChanged(key, false)
    setLabels((prev) => {
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }

  function rename(key: number, raw: string) {
    const label = raw.trim().slice(0, LABEL_MAX)
    if (label.length > 0) setLabels((prev) => new Map(prev).set(key, label))
  }

  const closeRename = useCallback(() => {
    if (renaming !== null) document.getElementById(`${baseId}-tab-${renaming}`)?.focus()
    setRenaming(null)
  }, [baseId, renaming])

  async function attachSelection() {
    const selection = terms.current.get(activeKey)?.getSelection() ?? ''
    if (selection.length === 0) return
    try {
      const path = await window.loom.terminal.attach(workspaceId, selection)
      push(`Attached ${path}`)
    } catch (err) {
      push(`Could not attach terminal selection: ${String(err)}`, 'err')
    }
  }

  const renamingTab = tabs.find((t) => t.key === renaming)

  return (
    <>
      {!collapsed && (
        <Splitter
          label="Resize terminal"
          axis="y"
          panel="after"
          value={termH}
          min={TERM_MIN}
          max={maxTerm}
          defaultValue={TERM_DEFAULT}
          onChange={setTermH}
          onCommit={commitPanels}
        />
      )}
      <div
        ref={panelRef}
        className="term-panel"
        data-collapsed={collapsed}
        style={collapsed ? undefined : { height: termH }}
      >
        <div className="term-tabs">
          <div className="term-tablist" role="tablist" aria-label="Terminals">
            {tabs.map((tab) => {
              const on = tab.key === activeKey
              const label = labels.get(tab.key) ?? tab.label
              return (
                <div key={tab.key} className="term-tab" data-on={on} role="presentation">
                  <button
                    type="button"
                    role="tab"
                    id={`${baseId}-tab-${tab.key}`}
                    aria-selected={on}
                    aria-controls={`${baseId}-host-${tab.key}`}
                    className="term-tab-main"
                    title="Double-click to rename"
                    onClick={() => setActiveKey(tab.key)}
                    onDoubleClick={() => setRenaming(tab.key)}
                  >
                    {label}
                  </button>
                  {tabs.length > 1 && (
                    <button
                      type="button"
                      className="term-tab-close"
                      aria-label={`Close ${label}`}
                      title="Close terminal"
                      onClick={() => closeTab(tab.key)}
                    >
                      ×
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <button
            type="button"
            className="term-tab-add"
            title="New terminal"
            aria-label="New terminal"
            onClick={addTab}
          >
            +
          </button>
          <button
            type="button"
            className="term-tab-collapse"
            title={collapsed ? 'Expand terminal' : 'Collapse terminal'}
            aria-label={collapsed ? 'Expand terminal' : 'Collapse terminal'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <svg
              className="icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
        <div className="term-body" hidden={collapsed}>
          <div className="term-actions">
            <button
              type="button"
              className="icon-btn"
              disabled={!withSelection.has(activeKey)}
              title="Attach selection"
              aria-label="Attach selection"
              onClick={() => void attachSelection()}
            >
              <svg
                className="icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m9 13 6-6a3 3 0 0 1 4.2 4.2l-8 8a5 5 0 0 1-7.1-7.1l8-8a2 2 0 0 1 2.8 2.8L7 14.8" />
              </svg>
            </button>
          </div>
          {tabs.map((tab) => (
            <ShellHost
              key={tab.key}
              tabKey={tab.key}
              hostId={`${baseId}-host-${tab.key}`}
              labelledBy={`${baseId}-tab-${tab.key}`}
              workspaceId={workspaceId}
              attach={tab.attach}
              detached={cloud}
              active={tab.key === activeKey}
              shown={!collapsed}
              onTerminal={register}
              onPty={trackPty}
              onSelection={selectionChanged}
            />
          ))}
        </div>
        {renamingTab !== undefined && (
          <RenamePopover
            key={renamingTab.key}
            anchorId={`${baseId}-tab-${renamingTab.key}`}
            initial={labels.get(renamingTab.key) ?? renamingTab.label}
            onCommit={(value) => {
              rename(renamingTab.key, value)
              closeRename()
            }}
            onCancel={closeRename}
          />
        )}
      </div>
    </>
  )
}

const GAP = 6

/**
 * Rename field pinned under a terminal tab. Portalled because the tab list scrolls horizontally
 * and would clip it; flips above the tab when there is no room below (a collapsed terminal sits
 * at the bottom of the window). Enter commits; Escape and outside presses cancel.
 */
function RenamePopover({
  anchorId,
  initial,
  onCommit,
  onCancel
}: {
  anchorId: string
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initial)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const tab = document.getElementById(anchorId)
    const pop = anchor?.querySelector('.popover')
    if (anchor === null || tab === null || pop === null || pop === undefined) return
    const r = tab.getBoundingClientRect()
    const { width, height } = pop.getBoundingClientRect()
    const below = r.bottom + GAP + height + WINDOW_EDGE <= window.innerHeight
    // `.popover` already sits GAP below its anchor.
    anchor.style.top = `${below ? r.bottom : r.top - height - 2 * GAP}px`
    anchor.style.left = `${clampInWindow(r.left, width, window.innerWidth)}px`
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [anchorId])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (anchorRef.current !== null && !anchorRef.current.contains(e.target as Node)) onCancel()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onCancel])

  return createPortal(
    <div ref={anchorRef} className="popover-wrap term-rename-anchor">
      <div className="popover elevated popover-left term-rename" role="dialog" aria-label="Rename terminal">
        <input
          ref={inputRef}
          className="input mono"
          aria-label="Terminal name"
          value={value}
          maxLength={LABEL_MAX}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onCommit(value)
            } else if (e.key === 'Escape') {
              // Keep Escape local: nothing above the popover should close with it.
              e.preventDefault()
              e.stopPropagation()
              onCancel()
            }
          }}
        />
      </div>
    </div>,
    document.body
  )
}

interface ShellHostProps {
  tabKey: number
  hostId: string
  labelledBy: string
  workspaceId: string
  /** Show this running terminal, with what it last printed, instead of starting a new one. */
  attach: TerminalInfo | undefined
  /** Leave the terminal running when this host goes away; only its tab being closed ends it. */
  detached: boolean
  active: boolean
  /** False while the terminal is collapsed to its tab bar. */
  shown: boolean
  onTerminal: (key: number, term: Terminal | null) => void
  onPty: (key: number, id: string | null) => void
  onSelection: (key: number, has: boolean) => void
}

/** One PTY + xterm instance, alive from mount to unmount regardless of visibility. */
function ShellHost(props: ShellHostProps) {
  const { tabKey, workspaceId, attach, detached, active, shown, onTerminal, onPty, onSelection } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const [ptyId, setPtyId] = useState<string | null>(null)
  const push = useToasts((s) => s.push)

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const cleanups: Array<() => void> = []
    let terminalId: string | null = null
    let disposed = false

    const term = new Terminal({
      convertEol: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
      // Must equal --panel-solid: the host's padding ring and the terminal are one flat surface.
      theme: { background: '#17171a', foreground: '#f4f4f5', cursor: '#e4e4e7' }
    })
    onTerminal(tabKey, term)
    const selectionChange = term.onSelectionChange(() => {
      onSelection(tabKey, term.getSelection().length > 0)
    })
    cleanups.push(() => selectionChange.dispose())
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    // A hidden host measures 0x0 and FitAddon would shrink the terminal to its minimum; skip
    // until it is visible again (the observer fires on show, and so does the active effect).
    const refit = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      if (terminalId !== null) void window.loom.terminal.resize(terminalId, term.cols, term.rows)
    }
    fitRef.current = refit
    refit()
    const observer = new ResizeObserver(refit)
    observer.observe(host)
    cleanups.push(() => observer.disconnect())

    void (async () => {
      let id: string
      if (attach !== undefined) {
        id = attach.id
        term.write(attach.scrollback)
      } else {
        try {
          id = await window.loom.terminal.create(workspaceId)
        } catch (err) {
          if (!disposed) push(`Could not start terminal: ${String(err)}`, 'err')
          return
        }
        // Never shown, so nothing is left running for it, here or on a runner.
        if (disposed) {
          void window.loom.terminal.destroy(id)
          return
        }
      }
      terminalId = id
      onPty(tabKey, id)
      cleanups.push(
        window.loom.onTerminalData((push) => {
          if (push.id === id) term.write(push.data)
        })
      )
      cleanups.push(
        window.loom.onTerminalExit((push) => {
          if (push.id === id) term.write('\r\n[process exited]\r\n')
        })
      )
      const input = term.onData((data) => {
        void window.loom.terminal.write(id, data)
      })
      cleanups.push(() => input.dispose())
      refit()
      setPtyId(id)
    })()

    return () => {
      disposed = true
      for (const cleanup of cleanups) cleanup()
      if (terminalId !== null && !detached) void window.loom.terminal.destroy(terminalId)
      onPty(tabKey, null)
      fitRef.current = null
      onTerminal(tabKey, null)
      term.dispose()
    }
  }, [tabKey, workspaceId, attach, detached, onTerminal, onPty, onSelection, push])

  // Report the visible terminal to main (run actions write there).
  useEffect(() => {
    if (!active || ptyId === null) return
    window.loom.terminal
      .setActive(ptyId)
      .catch((err: unknown) => push(`Could not activate terminal: ${String(err)}`, 'err'))
  }, [active, ptyId, push])

  // Refit once laid out again, on tab switch and on expand, so it never comes back at the size
  // it had (or the minimum it skipped to) while hidden.
  useEffect(() => {
    if (!active || !shown) return
    const frame = requestAnimationFrame(() => fitRef.current?.())
    return () => cancelAnimationFrame(frame)
  }, [active, shown])

  return (
    <div
      ref={hostRef}
      id={props.hostId}
      className="xterm-host"
      role="tabpanel"
      aria-labelledby={props.labelledBy}
      hidden={!active}
    />
  )
}
