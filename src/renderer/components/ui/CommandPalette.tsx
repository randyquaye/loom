import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { Effort } from '../../../shared/models'
import { useProjects } from '../../state/projects'
import { useSessions } from '../../state/sessions'
import { useUi } from '../../state/ui'
import { useFocusTrap } from './focus'
import { useToasts } from './Toast'
import '../chat/flow.css'

export const MOD_KEY = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'

type Group = 'Navigate' | 'Create' | 'Session'
const GROUPS: Group[] = ['Navigate', 'Create', 'Session']

interface Command {
  id: string
  group: Group
  label: string
  hint?: string
  run(): void
}

/** Subsequence match; rewards contiguous runs and word starts. Null when not a match. */
function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  const t = text.toLowerCase()
  let from = 0
  let prev = -2
  let score = 0
  for (const ch of q) {
    const i = t.indexOf(ch, from)
    if (i === -1) return null
    if (i === prev + 1) score += 2
    if (i === 0 || t[i - 1] === ' ') score += 3
    prev = i
    from = i + 1
  }
  return score - t.length / 100
}

function useCommands(): Command[] {
  const route = useUi((s) => s.route)
  const projects = useProjects((s) => s.projects)
  const workspacesByProject = useProjects((s) => s.workspacesByProject)
  const workspaceId = route.name === 'workspace' ? route.workspaceId : null
  const activeSession = useSessions((s) => {
    if (workspaceId === null) return null
    const id = s.activeSessionByWorkspace[workspaceId]
    return s.sessionsByWorkspace[workspaceId]?.find((x) => x.id === id) ?? null
  })

  return useMemo(() => {
    const ui = useUi.getState()
    const push = useToasts.getState().push
    const workspaces = Object.values(workspacesByProject).flat()
    const currentProjectId =
      workspaces.find((w) => w.id === workspaceId)?.projectId ?? projects[0]?.id ?? null
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? ''

    const commands: Command[] = [
      { id: 'home', group: 'Navigate', label: 'Go to Home', run: () => ui.navigate({ name: 'home' }) },
      {
        id: 'settings',
        group: 'Navigate',
        label: 'Open Settings',
        run: () => ui.navigate({ name: 'settings' })
      },
      ...workspaces
        .filter((w) => w.id !== workspaceId)
        .map<Command>((w) => ({
          id: `ws:${w.id}`,
          group: 'Navigate',
          label: `Open ${w.name}`,
          hint: projectName(w.projectId),
          run: () => ui.navigate({ name: 'workspace', workspaceId: w.id })
        })),
      { id: 'new-project', group: 'Create', label: 'New project', run: ui.openAddProject }
    ]

    if (currentProjectId !== null) {
      commands.push({
        id: 'new-workspace',
        group: 'Create',
        label: 'New workspace',
        hint: projectName(currentProjectId),
        run: () => ui.openAddWorkspace(currentProjectId)
      })
    }
    if (workspaceId !== null) {
      commands.push({
        id: 'new-session',
        group: 'Create',
        label: 'New session',
        run: () => ui.openNewSession(workspaceId)
      })
    }
    if (workspaceId !== null && activeSession !== null) {
      commands.push(
        {
          id: 'export',
          group: 'Session',
          label: 'Export active session',
          hint: 'Markdown',
          run: () => {
            window.loom.sessions
              .exportMarkdown(activeSession.id)
              .then((path) => {
                if (path !== null) push(`Exported to ${path}`)
              })
              .catch((err: unknown) => push(`Export failed: ${String(err)}`, 'err'))
          }
        },
        {
          id: 'fork',
          group: 'Session',
          label: 'Fork active session',
          run: () => {
            const sessions = useSessions.getState()
            window.loom.sessions
              .fork({
                workspaceId,
                backend: activeSession.backend,
                model: activeSession.model,
                effort: activeSession.effort as Effort,
                sourceSessionId: activeSession.id
              })
              .then(async (row) => {
                await sessions.load(workspaceId)
                sessions.setActive(workspaceId, row.id)
                push('Forked session')
              })
              .catch((err: unknown) => push(`Fork failed: ${String(err)}`, 'err'))
          }
        }
      )
    }
    return commands
  }, [projects, workspacesByProject, workspaceId, activeSession])
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return
      const { modals, paletteOpen, togglePalette } = useUi.getState()
      // Never stack the palette over a half-filled form: the ModalHost flags cover the global
      // modals, the DOM check covers route-local ones (e.g. the Settings API key modal).
      const modalOpen =
        modals.addWorkspaceFor !== null ||
        document.querySelector('.modal[aria-modal="true"]:not(.palette)') !== null
      if (!paletteOpen && modalOpen) return
      e.preventDefault()
      togglePalette()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return open ? <PaletteSurface /> : null
}

function PaletteSurface() {
  const close = useUi((s) => s.closePalette)
  const commands = useCommands()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useFocusTrap(surfaceRef, true)
  // Focus after the trap has recorded the opener (autoFocus would run before it).
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const results = useMemo(() => {
    if (query.trim() === '') return commands
    const scored = commands.flatMap((c) => {
      const score = fuzzyScore(query, c.label)
      return score === null ? [] : [{ c, score }]
    })
    // Keep group order stable, rank within each group.
    return GROUPS.flatMap((g) =>
      scored
        .filter((x) => x.c.group === g)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.c)
    )
  }, [commands, query])

  const current = Math.min(active, Math.max(results.length - 1, 0))
  const activeCmd = results[current]

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [current])

  function run(cmd: Command | undefined) {
    if (cmd === undefined) return
    close()
    cmd.run()
  }

  function onKeyDown(e: ReactKeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (results.length === 0) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((current + step + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(activeCmd)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={surfaceRef}
        className="palette modal glass"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command or search…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={activeCmd ? `palette-${activeCmd.id}` : undefined}
        />
        <div ref={listRef} id="palette-list" className="palette-list" role="listbox">
          {results.length === 0 && <div className="palette-empty">No matching commands</div>}
          {results.map((cmd, i) => (
            <PaletteRow
              key={cmd.id}
              cmd={cmd}
              index={i}
              active={i === current}
              showGroup={i === 0 || results[i - 1]?.group !== cmd.group}
              onHover={() => setActive(i)}
              onRun={() => run(cmd)}
            />
          ))}
        </div>
        <div className="palette-foot">
          <span>
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> navigate
          </span>
          <span>
            <kbd className="kbd">↵</kbd> run
          </span>
          <span>
            <kbd className="kbd">esc</kbd> close
          </span>
          <span className="spacer" />
          <span>
            <kbd className="kbd">{MOD_KEY}</kbd> <kbd className="kbd">K</kbd> toggle
          </span>
        </div>
      </div>
    </div>
  )
}

function PaletteRow({
  cmd,
  index,
  active,
  showGroup,
  onHover,
  onRun
}: {
  cmd: Command
  index: number
  active: boolean
  showGroup: boolean
  onHover: () => void
  onRun: () => void
}) {
  return (
    <>
      {showGroup && <div className="palette-group">{cmd.group}</div>}
      <button
        id={`palette-${cmd.id}`}
        type="button"
        role="option"
        aria-selected={active}
        tabIndex={-1}
        className="list-option palette-item"
        data-index={index}
        data-active={active}
        onMouseMove={onHover}
        onClick={onRun}
      >
        <span className="grow">{cmd.label}</span>
        {cmd.hint !== undefined && <span className="palette-hint">{cmd.hint}</span>}
      </button>
    </>
  )
}
