import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import type {
  LinearIssueListResult,
  LinearIssueSummary,
  PullRequestListResult,
  PullRequestSummary
} from '../../../shared/ipc-contract'
import type { BackendId, Effort } from '../../../shared/models'
import { initialChoice, useDefaults } from '../../state/defaults'
import { useProjects } from '../../state/projects'
import { useSessions } from '../../state/sessions'
import { useUi } from '../../state/ui'
import { ModelPicker } from '../chat/ModelPicker'
import { ErrorState } from '../ui/ErrorState'
import { FolderIcon, GlobeIcon } from '../ui/icons'
import { Modal } from '../ui/Modal'
import { Popover } from '../ui/Popover'
import { useToasts } from '../ui/Toast'
import { CloneRepoModal } from './CloneRepoModal'
import { ProjectMenu } from './ProjectMenu'
import { workspaceNameFromPrompt } from './workspaceName'
import './new-workspace.css'

interface Choice {
  backend: BackendId
  model: string
  effort: Effort
}

/**
 * Conductor-style "new workspace": pick the project, optionally a base branch, write the first
 * prompt and pick the model. Create makes the workspace (name derived from the prompt), opens
 * it, starts a session on the picked model and sends the prompt as its first turn. It opens
 * prompt-first: focus lands in the prompt and the project list stays closed until asked for.
 */
export function NewWorkspaceModal({
  projectId: initialProjectId,
  projectMenu = false
}: {
  /** null opens with no project chosen; Create waits until one is picked. */
  projectId: string | null
  /** Start with the project menu open (the "New project" entry points). */
  projectMenu?: boolean
}) {
  const closeModals = useUi((s) => s.closeModals)
  const navigate = useUi((s) => s.navigate)
  const projects = useProjects((s) => s.projects)
  const workspacesByProject = useProjects((s) => s.workspacesByProject)
  const addWorkspace = useProjects((s) => s.addWorkspace)
  const createSession = useSessions((s) => s.create)
  const send = useSessions((s) => s.send)
  const modelsByBackend = useSessions((s) => s.modelsByBackend)
  const loadout = useDefaults((s) => s.loadout)
  const push = useToasts((s) => s.push)
  const [projectId, setProjectId] = useState<string | null>(initialProjectId)
  const [baseRef, setBaseRef] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [picked, setPicked] = useState<Choice | null>(null)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(projectMenu)
  const [listOpen, setListOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const projectTriggerRef = useRef<HTMLButtonElement>(null)
  // Escape reaches every open Modal's window listener; this one must stay open beneath the clone modal.
  const cloneOpenRef = useRef(cloneOpen)
  cloneOpenRef.current = cloneOpen
  // Stable identity: Modal re-runs its autofocus whenever onClose changes.
  const close = useCallback(() => {
    if (!cloneOpenRef.current) closeModals()
  }, [closeModals])
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  const closeList = useCallback(() => setListOpen(false), [])
  const closeClone = useCallback(() => setCloneOpen(false), [])

  /** Picking a project hands focus back to the prompt: the user is mid-thought, not mid-form. */
  function selectProject(id: string) {
    setProjectId(id)
    setBaseRef(null)
    setMenuOpen(false)
    setListOpen(false)
    promptRef.current?.focus()
  }

  function openClone() {
    setMenuOpen(false)
    setListOpen(false)
    setCloneOpen(true)
  }

  // An issue seeds the prompt; never clobber what the user already typed.
  function seedPrompt(block: string) {
    setPrompt((current) => (current.trim() === '' ? block : `${current}\n\n${block}`))
    promptRef.current?.focus()
  }

  const { backend, model, effort } = picked ?? initialChoice(loadout, modelsByBackend)
  const project = projects.find((p) => p.id === projectId) ?? null
  const ready = prompt.trim() !== '' && model !== '' && !busy && project !== null

  async function submit() {
    if (!ready || projectId === null) return
    setBusy(true)
    const text = prompt.trim()
    const name = workspaceNameFromPrompt(
      text,
      (workspacesByProject[projectId] ?? []).map((w) => w.name)
    )
    let workspaceId: string
    try {
      workspaceId = (await addWorkspace(projectId, name, baseRef)).id
    } catch (err) {
      // Keep the modal and the prompt so the user can pick another project or retry (e.g. at the cap).
      push(`Could not create workspace: ${String(err)}`, 'err')
      setBusy(false)
      return
    }
    // Create the session before navigating so the workspace's first session load already has it.
    let sessionId: string | null = null
    try {
      sessionId = (await createSession(workspaceId, backend, model, effort)).id
    } catch (err) {
      push(`Created ${name}, but could not start a session: ${String(err)}`, 'err')
    }
    close()
    navigate({ name: 'workspace', workspaceId })
    if (sessionId === null) {
      // The workspace opens in compose mode; hand it the prompt so nothing typed is lost.
      useUi.getState().setDraft(text)
      return
    }
    send(sessionId, text).catch((err: unknown) => {
      push(`Send failed: ${String(err)}`, 'err')
      useUi.getState().setDraft(text)
    })
  }

  const head = (
    <>
      <div className="nw-project popover-wrap">
        <div className="dropdown">
          <button
            ref={projectTriggerRef}
            type="button"
            className="dropdown-trigger"
            aria-haspopup="menu"
            aria-expanded={listOpen}
            aria-label={project === null ? 'Choose a project' : `Project: ${project.name}`}
            onClick={() => {
              setMenuOpen(false)
              setListOpen((open) => !open)
            }}
          >
            <span className="grow nw-project-name">{project?.name ?? 'Choose a project…'}</span>
            <span className="dropdown-caret" aria-hidden="true" />
          </button>
        </div>
        <Popover
          open={listOpen}
          onClose={closeList}
          anchorRef={projectTriggerRef}
          className="nw-project-menu"
        >
          {projects.length === 0 ? (
            <div className="popover-label" role="presentation">
              No projects yet
            </div>
          ) : (
            <div className="nw-project-list" role="group" aria-label="Projects">
              {projects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className="list-option popover-item"
                  onClick={() => selectProject(p.id)}
                >
                  <span className="grow nw-project-name">{p.name}</span>
                  {p.id === projectId && (
                    <span className="dropdown-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="popover-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="list-option popover-item"
            onClick={() => {
              setListOpen(false)
              setMenuOpen(true)
            }}
          >
            <FolderIcon />
            <span className="grow">Open project…</span>
          </button>
          <button type="button" role="menuitem" className="list-option popover-item" onClick={openClone}>
            <GlobeIcon />
            <span className="grow">Clone a repository…</span>
          </button>
        </Popover>
        <ProjectMenu open={menuOpen} onClose={closeMenu} onPick={selectProject} onClone={openClone} />
      </div>
      <span className="spacer" />
      {/* Branches and PRs belong to a repository, so the chip waits for a project. */}
      {projectId !== null && (
        <BaseRefPicker
          projectId={projectId}
          value={baseRef}
          onChange={setBaseRef}
          onSeedPrompt={seedPrompt}
          onOpenSettings={() => {
            close()
            navigate({ name: 'settings' })
          }}
        />
      )}
    </>
  )

  const footer = (
    <>
      <ModelPicker
        backend={backend}
        model={model}
        effort={effort}
        onPick={(b, m, e) => setPicked({ backend: b, model: m, effort: e })}
      />
      <span className="spacer" />
      {project === null && <span className="nw-need-project">Choose a project to create</span>}
      <button
        type="button"
        className="icon-btn"
        aria-disabled="true"
        aria-label="Add attachment"
        title="Attachments are not available yet"
      >
        +
      </button>
      <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => void submit()}>
        {busy ? 'Creating…' : 'Create'}
        <span className="nw-enter" aria-hidden="true">
          ↵
        </span>
      </button>
    </>
  )

  return (
    <>
      <Modal
        open
        title="New workspace"
        onClose={close}
        head={head}
        footer={footer}
        width={720}
        className="nw-modal"
      >
        <textarea
          ref={promptRef}
          data-autofocus
          className="nw-prompt"
          aria-label="What do you want to work on?"
          placeholder="What do you want to work on?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
      </Modal>
      {/* A sibling, not a child: the glass modal's backdrop-filter would contain a fixed overlay. */}
      {cloneOpen && (
        <CloneRepoModal
          onClose={closeClone}
          onCloned={(project) => {
            selectProject(project.id)
            setCloneOpen(false)
          }}
        />
      )}
    </>
  )
}

type Tab = 'prs' | 'branches' | 'issues'
const TABS: { id: Tab; label: string }[] = [
  { id: 'prs', label: 'PRs' },
  { id: 'branches', label: 'Branches' },
  { id: 'issues', label: 'Issues' }
]

/** One picker row: a branch (null is "current HEAD"), a pull request or a Linear issue, sharing keyboard and aria. */
type Row =
  | { kind: 'branch'; ref: string | null }
  | { kind: 'pr'; pr: PullRequestSummary }
  | { kind: 'issue'; issue: LinearIssueSummary }

/** Typing in the PR tab refetches from GitHub; wait for a pause rather than every keystroke. */
const PR_DEBOUNCE_MS = 200
/** Same for the Issues tab, which queries Linear. */
const ISSUE_DEBOUNCE_MS = 200

/** Identifier first: the workspace name comes from the prompt's first words (e.g. eng-123-fix-login). */
function issuePrompt(issue: LinearIssueSummary): string {
  const head = `${issue.identifier}: ${issue.title}\n\n${issue.url}`
  return issue.description === null || issue.description.trim() === ''
    ? head
    : `${head}\n\n${issue.description}`
}

/**
 * Integrations chip + popover (search, PRs / Branches / Issues). Branches lists the project's
 * local branches; PRs searches GitHub through gh. Picking either sets the new worktree's base
 * ref (a PR contributes its head branch). Issues lists the viewer's assigned Linear issues; picking one
 * seeds the prompt instead and leaves the base ref alone.
 */
function BaseRefPicker({
  projectId,
  value,
  onChange,
  onSeedPrompt,
  onOpenSettings
}: {
  projectId: string
  value: string | null
  onChange: (ref: string | null) => void
  /** Receives an issue's prompt block; the parent owns merging it and focusing the prompt. */
  onSeedPrompt: (text: string) => void
  onOpenSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('branches')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [branches, setBranches] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Results remember the query they answer so the empty state never quotes a newer query.
  const [prs, setPrs] = useState<{ query: string; result: PullRequestListResult } | null>(null)
  const [prError, setPrError] = useState<string | null>(null)
  const [issues, setIssues] = useState<{ query: string; result: LinearIssueListResult } | null>(null)
  const [issueError, setIssueError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const baseId = useId()

  useEffect(() => {
    if (!open) return
    let live = true
    setBranches(null)
    setError(null)
    window.loom.git
      .branches(projectId)
      .then((list) => {
        if (live) setBranches(list)
      })
      .catch((err: unknown) => {
        if (live) setError(String(err))
      })
    return () => {
      live = false
    }
  }, [open, projectId, attempt])

  // A new project or a fresh open must not show the previous list while loading.
  useEffect(() => {
    setPrs(null)
    setPrError(null)
    setIssues(null)
    setIssueError(null)
  }, [open, projectId])

  useEffect(() => {
    if (!open || tab !== 'prs') return
    let live = true
    const timer = setTimeout(() => {
      setPrError(null)
      window.loom.github
        .prs(projectId, query.trim() === '' ? null : query)
        .then((result) => {
          if (live) setPrs({ query, result })
        })
        .catch((err: unknown) => {
          if (live) setPrError(String(err))
        })
    }, PR_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, tab, projectId, query, attempt])

  useEffect(() => {
    if (!open || tab !== 'issues') return
    let live = true
    const timer = setTimeout(() => {
      setIssueError(null)
      window.loom.linear
        .issues(query.trim() === '' ? null : query)
        .then((result) => {
          if (live) setIssues({ query, result })
        })
        .catch((err: unknown) => {
          if (live) setIssueError(String(err))
        })
    }, ISSUE_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, tab, projectId, query, attempt])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const q = query.trim().toLowerCase()
  // null is "no base branch": the worktree starts from the repo's current HEAD.
  const branchRows: (string | null)[] =
    tab !== 'branches' || branches === null
      ? []
      : [...(q === '' ? [null] : []), ...branches.filter((b) => b.toLowerCase().includes(q))]
  const prResult = tab === 'prs' && prError === null ? (prs?.result ?? null) : null
  const issueResult = tab === 'issues' && issueError === null ? (issues?.result ?? null) : null
  // GitHub and Linear already filtered by the query; those tabs render their result as-is.
  const rows: Row[] =
    tab === 'prs'
      ? prResult?.kind === 'ok'
        ? prResult.pullRequests.map((pr) => ({ kind: 'pr', pr }))
        : []
      : tab === 'issues'
        ? issueResult?.kind === 'ok'
          ? issueResult.issues.map((issue) => ({ kind: 'issue', issue }))
          : []
        : branchRows.map((ref) => ({ kind: 'branch', ref }))
  const activeIndex = Math.min(active, Math.max(rows.length - 1, 0))

  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex])

  function close(refocus: boolean) {
    setOpen(false)
    setQuery('')
    if (refocus) triggerRef.current?.focus()
  }

  function choose(index: number) {
    const row = rows[index]
    if (row === undefined) return
    if (row.kind === 'issue') {
      // Not a base ref: hand the block to the prompt, which takes focus instead of the trigger.
      close(false)
      onSeedPrompt(issuePrompt(row.issue))
      return
    }
    onChange(row.kind === 'branch' ? row.ref : row.pr.headRefName)
    close(true)
  }

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length > 0) {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((activeIndex + step + rows.length) % rows.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(activeIndex)
    }
  }

  return (
    <div className="popover-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="nw-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Base branch, pull requests and issues"
        onClick={() => {
          if (open) close(false)
          else {
            setActive(0)
            setOpen(true)
          }
        }}
      >
        <span className="nw-branch-glyph" aria-hidden="true">
          ⎇
        </span>
        <span className="nw-chip-label">{value ?? 'HEAD'}</span>
        <span className="dropdown-caret" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="nw-integrations elevated"
          role="dialog"
          aria-label="Base branch and integrations"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Keep Escape local: the enclosing modal must not close too.
              e.stopPropagation()
              close(true)
            }
          }}
        >
          <label className="nw-search">
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              onKeyDown={onSearchKey}
              placeholder={
                tab === 'branches'
                  ? 'Search branches'
                  : tab === 'issues'
                    ? 'Search by title or identifier'
                    : 'Search by title, number, or author'
              }
              role="combobox"
              aria-expanded="true"
              aria-controls={`${baseId}-list`}
              aria-activedescendant={rows.length > 0 ? `${baseId}-row-${activeIndex}` : undefined}
            />
          </label>
          <div className="nw-tabs" role="tablist" aria-label="Source">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                className="nw-tab"
                aria-selected={tab === t.id}
                onClick={() => {
                  setTab(t.id)
                  setActive(0)
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div ref={listRef} id={`${baseId}-list`} className="nw-list" role="listbox">
            {tab === 'prs' && (
              <PrState
                result={prResult}
                error={prError}
                resultQuery={prs?.query ?? ''}
                onRetry={() => {
                  setPrs(null)
                  setPrError(null)
                  setAttempt((n) => n + 1)
                }}
                onOpenSettings={onOpenSettings}
              />
            )}
            {tab === 'issues' && (
              <IssueState
                result={issueResult}
                error={issueError}
                resultQuery={issues?.query ?? ''}
                onRetry={() => {
                  setIssues(null)
                  setIssueError(null)
                  setAttempt((n) => n + 1)
                }}
                onOpenSettings={onOpenSettings}
              />
            )}
            {tab === 'branches' && error !== null && (
              <ErrorState
                compact
                title="Couldn’t list branches"
                detail={error}
                onRetry={() => setAttempt((n) => n + 1)}
              />
            )}
            {tab === 'branches' && error === null && branches === null && (
              <div className="nw-empty">Loading branches…</div>
            )}
            {tab === 'branches' && branches !== null && rows.length === 0 && (
              <div className="nw-empty">No branches match “{query}”.</div>
            )}
            {rows.map((row, i) => {
              // Issues seed the prompt rather than persist, so they never show as selected.
              const selected =
                row.kind === 'branch' ? row.ref === value : row.kind === 'pr' && row.pr.headRefName === value
              return (
                <button
                  key={
                    row.kind === 'branch'
                      ? (row.ref ?? '(head)')
                      : row.kind === 'pr'
                        ? `pr-${row.pr.number}`
                        : `issue-${row.issue.id}`
                  }
                  id={`${baseId}-row-${i}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  className="list-option nw-row"
                  data-index={i}
                  data-active={i === activeIndex}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(i)}
                >
                  {row.kind === 'branch' && (
                    <>
                      <span className="nw-branch-glyph" aria-hidden="true">
                        ⎇
                      </span>
                      <span className="nw-branch-name grow">{row.ref ?? 'Current HEAD'}</span>
                    </>
                  )}
                  {row.kind === 'pr' && (
                    <>
                      <span className="nw-pr-number">#{row.pr.number}</span>
                      <span className="nw-pr-title grow">{row.pr.title}</span>
                      <span className="nw-pr-refs" title={`${row.pr.headRefName} → ${row.pr.baseRefName}`}>
                        {row.pr.headRefName} → {row.pr.baseRefName}
                      </span>
                      {row.pr.isDraft && <span className="nw-pr-draft">Draft</span>}
                    </>
                  )}
                  {row.kind === 'issue' && (
                    <>
                      <span className="nw-issue-id">{row.issue.identifier}</span>
                      <span className="nw-issue-title grow">{row.issue.title}</span>
                      <span className="nw-issue-state">{row.issue.stateName}</span>
                    </>
                  )}
                  {selected && (
                    <span className="dropdown-check" aria-hidden="true">
                      ✓
                    </span>
                  )}
                  <span className="nw-select-hint" aria-hidden="true">
                    Select ↵
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Every non-row state of the PR tab. Blockers arrive as data from main, so each gets its own
 * honest message; only a rejected call or a `failed` result offers a retry.
 */
function PrState({
  result,
  error,
  resultQuery,
  onRetry,
  onOpenSettings
}: {
  result: PullRequestListResult | null
  error: string | null
  resultQuery: string
  onRetry: () => void
  onOpenSettings: () => void
}) {
  if (error !== null || result?.kind === 'failed') {
    return (
      <ErrorState
        compact
        title="Couldn’t list pull requests"
        detail={error ?? (result?.kind === 'failed' ? result.message : undefined)}
        onRetry={onRetry}
      />
    )
  }
  if (result === null) return <div className="nw-empty">Loading pull requests…</div>
  switch (result.kind) {
    case 'ok':
      if (result.pullRequests.length > 0) return null
      return (
        <div className="nw-empty">
          {resultQuery.trim() === ''
            ? 'This repository has no open pull requests.'
            : `No pull requests match “${resultQuery}”.`}
        </div>
      )
    case 'no-remote':
      return <div className="nw-empty">This project has no GitHub remote.</div>
    case 'not-installed':
    case 'not-authenticated':
      return (
        <div className="nw-empty">
          <span className="nw-empty-title">
            {result.kind === 'not-installed' ? 'GitHub CLI not installed' : 'GitHub sign-in required'}
          </span>
          <span className="nw-empty-hint">{result.hint}</span>
          <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      )
  }
}

/**
 * Every non-row state of the Issues tab. Like the PR tab, blockers arrive as data from main;
 * only a rejected call or a `failed` result offers a retry.
 */
function IssueState({
  result,
  error,
  resultQuery,
  onRetry,
  onOpenSettings
}: {
  result: LinearIssueListResult | null
  error: string | null
  resultQuery: string
  onRetry: () => void
  onOpenSettings: () => void
}) {
  if (error !== null || result?.kind === 'failed') {
    return (
      <ErrorState
        compact
        title="Couldn’t list issues"
        detail={error ?? (result?.kind === 'failed' ? result.message : undefined)}
        onRetry={onRetry}
      />
    )
  }
  if (result === null) return <div className="nw-empty">Loading issues…</div>
  switch (result.kind) {
    case 'ok':
      if (result.issues.length > 0) return null
      return (
        <div className="nw-empty">
          {resultQuery.trim() === ''
            ? 'You have no assigned Linear issues.'
            : `No issues match “${resultQuery}”.`}
        </div>
      )
    case 'needs-key':
    case 'invalid-key':
      return (
        <div className="nw-empty">
          <span className="nw-empty-title">
            {result.kind === 'needs-key' ? 'Linear API key required' : 'Linear API key rejected'}
          </span>
          <span className="nw-empty-hint">{result.hint}</span>
          <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      )
  }
}
