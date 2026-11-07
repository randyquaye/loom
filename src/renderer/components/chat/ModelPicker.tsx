import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { BACKEND_IDS, type BackendId, type Effort } from '../../../shared/models'
import { entryKey, sameEntry, useDefaults, type LoadoutEntry } from '../../state/defaults'
import { useSessions } from '../../state/sessions'
import { useUi } from '../../state/ui'
import { MOD_KEY } from '../ui/CommandPalette'
import { ErrorState } from '../ui/ErrorState'
import './model-picker.css'

interface Row extends LoadoutEntry {
  label: string
  /** 'default' for loadout[0]; 'current' for a forking session's combo outside the loadout. */
  tag: 'default' | 'current' | null
}

/** Cmd/Ctrl+Shift+/ cycles effort; e.code keeps it layout-independent ('/' reports '?' with shift). */
function isCycleEffort(e: KeyboardEvent | ReactKeyboardEvent): boolean {
  return e.code === 'Slash' && e.shiftKey && (e.metaKey || e.ctrlKey)
}

/**
 * Composer-anchored model picker (conductor anatomy): the loadout in order, one row per
 * backend · model · effort entry with the first marked default and a check on the current
 * one, an effort row, and a footer linking to Settings → Default models (the only place
 * the full catalog is shown). In 'compose' mode a pick sets the session about to start;
 * in 'fork' mode (live session) model and effort are fixed per session, so any
 * different pick forks into a new tab instead, and the effort shortcut is off.
 */
export function ModelPicker({
  backend,
  model,
  effort,
  onPick,
  mode = 'compose'
}: {
  backend: BackendId
  model: string
  effort: Effort
  onPick(backend: BackendId, model: string, effort: Effort): void
  mode?: 'compose' | 'fork'
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const modelsByBackend = useSessions((s) => s.modelsByBackend)
  const modelErrorByBackend = useSessions((s) => s.modelErrorByBackend)
  const loadModels = useSessions((s) => s.loadModels)
  const retryModels = useSessions((s) => s.retryModels)
  const loadout = useDefaults((s) => s.loadout)
  const navigate = useUi((s) => s.navigate)
  const forking = mode === 'fork'

  const current = (modelsByBackend[backend] ?? []).find((m) => m.id === model)
  const efforts = current?.efforts ?? []

  useEffect(() => {
    for (const b of BACKEND_IDS) void loadModels(b)
  }, [loadModels])

  const rows = useMemo<Row[]>(() => {
    // Labels resolve once a catalog loads; a failed catalog shows the raw model id.
    const label = (b: BackendId, m: string) => modelsByBackend[b]?.find((d) => d.id === m)?.label ?? m
    const list: Row[] = loadout.map((e, i) => ({
      ...e,
      label: label(e.backend, e.model),
      tag: i === 0 ? 'default' : null
    }))
    // A live session can always stay where it is, even on a combo the loadout no longer holds.
    const live = { backend, model, effort }
    if (forking && model !== '' && !loadout.some((e) => sameEntry(e, live))) {
      list.unshift({ ...live, label: label(backend, model), tag: 'current' })
    }
    return list
  }, [modelsByBackend, loadout, forking, backend, model, effort])

  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0))
  const failed = BACKEND_IDS.filter((b) => modelErrorByBackend[b] !== undefined)
  const catalogFailed = modelErrorByBackend[backend] !== undefined
  // An empty model means the start composer is still waiting on its catalog.
  let pillLabel = current?.label ?? model
  if (model === '') pillLabel = catalogFailed ? 'Models unavailable' : 'Loading…'

  function retryFailed() {
    for (const b of failed) void retryModels(b)
  }

  function close(refocus: boolean) {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  function show() {
    const i = rows.findIndex((r) => sameEntry(r, { backend, model, effort }))
    setActive(Math.max(i, 0))
    setOpen(true)
  }

  function choose(b: BackendId, m: string, e: Effort) {
    if (b === backend && m === model && e === effort) return
    onPick(b, m, e)
  }

  function pick(row: Row | undefined) {
    if (row === undefined) return
    choose(row.backend, row.model, row.effort)
    close(true)
  }

  function cycleEffort() {
    if (efforts.length === 0) return
    const next = efforts[(efforts.indexOf(effort) + 1) % efforts.length]
    if (next !== undefined) onPick(backend, model, next)
  }

  // Outside click closes; the cycle shortcut works while composing (forking a tab per keypress would not).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (open && wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) close(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (forking || !isCycleEffort(e)) return
      e.preventDefault()
      cycleEffort()
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  })

  // The list takes focus on open so arrows and Enter work without a search field.
  useEffect(() => {
    if (open) listRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  function onListKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((activeIndex + step + rows.length) % rows.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      pick(rows[activeIndex])
    }
  }

  return (
    <div className="popover-wrap model-picker-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="model-pill"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={forking ? 'Fixed for this session; pick another to fork a new tab' : 'Model and effort'}
        onClick={() => (open ? close(false) : show())}
      >
        <span className={`provider-dot provider-${backend}`} aria-hidden="true" />
        <span className="model-pill-name">{pillLabel}</span>
        {model !== '' && <span className="model-pill-effort">{effort}</span>}
        <span className="dropdown-caret" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="model-picker elevated"
          role="dialog"
          aria-label={forking ? 'Fork with another model' : 'Choose model'}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Keep Escape local: an enclosing surface must not close too.
              e.stopPropagation()
              close(true)
            }
          }}
        >
          <div
            ref={listRef}
            className="model-list"
            role="listbox"
            tabIndex={0}
            aria-label="Loadout"
            aria-activedescendant={rows[activeIndex] ? `model-${activeIndex}` : undefined}
            onKeyDown={onListKey}
          >
            {rows.map((r, i) => {
              const on = sameEntry(r, { backend, model, effort })
              // Provider readiness lives in Settings; the row's provider dot is the only identity cue here.
              return (
                <button
                  key={`${r.tag ?? ''}:${entryKey(r)}`}
                  id={`model-${i}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={on}
                  className="list-option model-row"
                  data-index={i}
                  data-active={i === activeIndex}
                  data-on={on}
                  onMouseMove={() => setActive(i)}
                  onClick={() => pick(r)}
                >
                  <span className={`provider-dot provider-${r.backend}`} aria-hidden="true" />
                  <span className="model-row-name">
                    {r.backend} · {r.label}
                  </span>
                  <span className="model-row-effort grow">{r.effort}</span>
                  {r.tag !== null && (
                    <span
                      className="model-row-tag"
                      title={r.tag === 'default' ? 'New sessions start here' : undefined}
                    >
                      {r.tag}
                    </span>
                  )}
                  <span className="model-check" aria-hidden="true">
                    {on ? '✓' : ''}
                  </span>
                </button>
              )
            })}
            {rows.length === 0 && (
              <div className="model-empty">
                Your loadout is empty. Add models in Settings → Default models.
              </div>
            )}
            {failed.length > 0 && (
              <ErrorState
                compact
                title={`Couldn’t load ${failed.join(', ')} models`}
                detail={failed.map((b) => modelErrorByBackend[b]).join('\n')}
                onRetry={retryFailed}
              />
            )}
          </div>

          <div className="model-section">
            <div className="model-setting">
              <span className="grow">Effort</span>
              <div className="segmented" role="radiogroup" aria-label="Effort">
                {efforts.map((e) => (
                  <button
                    key={e}
                    type="button"
                    role="radio"
                    aria-checked={e === effort}
                    data-on={e === effort}
                    onClick={() => {
                      choose(backend, model, e)
                      // A fork replaces this composer; close rather than leave a stale popover.
                      if (forking) close(false)
                    }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="model-foot">
            <button
              type="button"
              className="model-foot-btn"
              onClick={() => {
                close(false)
                navigate({ name: 'settings', page: 'models' })
              }}
            >
              <span aria-hidden="true">⚙</span> Edit loadout
            </button>
            <span className="spacer" />
            {forking ? (
              <span>Picking forks a new tab</span>
            ) : (
              <>
                <kbd className="kbd">{MOD_KEY}⇧/</kbd>
                <span>Cycle effort</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
