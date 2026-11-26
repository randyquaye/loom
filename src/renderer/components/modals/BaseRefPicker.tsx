import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type {
  LinearIssueListResult,
  LinearIssueSummary,
  PullRequestListResult,
  PullRequestSummary
} from '../../../shared/ipc-contract'
import { ErrorState } from '../ui/ErrorState'

type Tab = 'prs' | 'branches' | 'issues'
const TABS: { id: Tab; label: string }[] = [
  { id: 'prs', label: 'PRs' },
  { id: 'branches', label: 'Branches' },
  { id: 'issues', label: 'Issues' }
]

/** One picker row: a branch (null is the default), a pull request or a Linear issue, sharing keyboard and aria. */
type Row =
  | { kind: 'branch'; ref: string | null }
  | { kind: 'pr'; pr: PullRequestSummary }
  | { kind: 'issue'; issue: LinearIssueSummary }

/** PR and Issues searches hit GitHub or Linear; wait for a typing pause rather than every keystroke. */
const SEARCH_DEBOUNCE_MS = 200

/** Identifier first: the workspace name comes from the prompt's first words (e.g. eng-123-fix-login). */
function issuePrompt(issue: LinearIssueSummary): string {
  const head = `${issue.identifier}: ${issue.title}\n\n${issue.url}`
  return issue.description === null || issue.description.trim() === ''
    ? head
    : `${head}\n\n${issue.description}`
}

const searchPrs = (query: string | null, projectId: string, cloud: boolean) =>
  window.loom.github.prs(projectId, query, cloud)
const searchIssues = (query: string | null) => window.loom.linear.issues(query)

/**
 * One remotely searched tab (PRs or Issues), fetched while the popover is open on it. Results
 * remember the query they answer so the empty state never quotes a newer query; `clear` drops
 * both result and error so a retry shows loading.
 */
function useDebouncedSearch<T>(
  search: (query: string | null, projectId: string, cloud: boolean) => Promise<T>,
  {
    open,
    active,
    projectId,
    query,
    attempt,
    cloud
  }: { open: boolean; active: boolean; projectId: string; query: string; attempt: number; cloud: boolean }
) {
  const [found, setFound] = useState<{ query: string; result: T } | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A new project or a fresh open must not show the previous list while loading.
  useEffect(() => {
    setFound(null)
    setError(null)
  }, [open, projectId, cloud])

  useEffect(() => {
    if (!open || !active) return
    let live = true
    const timer = setTimeout(() => {
      setError(null)
      search(query.trim() === '' ? null : query, projectId, cloud)
        .then((result) => {
          if (live) setFound({ query, result })
        })
        .catch((err: unknown) => {
          if (live) setError(String(err))
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [search, open, active, projectId, query, attempt, cloud])

  function clear() {
    setFound(null)
    setError(null)
  }

  return { found, error, clear }
}

/**
 * Integrations chip + popover (search, PRs / Branches / Issues). Branches lists the project's
 * local branches; PRs searches GitHub through gh. Picking either sets the new worktree's base
 * ref (a PR contributes its head branch). Issues lists the viewer's assigned Linear issues; picking one
 * seeds the prompt instead and leaves the base ref alone.
 */
export function BaseRefPicker({
  projectId,
  value,
  onChange,
  onSeedPrompt,
  onOpenSettings,
  cloud = false
}: {
  cloud?: boolean
  projectId: string
  value: string | null
  onChange: (ref: string | null) => void
  /** Receives an issue's prompt block; the parent owns merging it and focusing the prompt. */
  onSeedPrompt: (text: string) => void
  onOpenSettings: (integration: 'github' | 'linear') => void
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('branches')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [branches, setBranches] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
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

  const searchInputs = { open, projectId, query, attempt, cloud }
  const prSearch = useDebouncedSearch(searchPrs, { ...searchInputs, active: tab === 'prs' })
  const issueSearch = useDebouncedSearch(searchIssues, { ...searchInputs, active: tab === 'issues' })

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const q = query.trim().toLowerCase()
  // null uses the latest remote default branch, or local HEAD without an origin.
  const branchRows: (string | null)[] =
    tab !== 'branches' || branches === null
      ? []
      : [...(q === '' ? [null] : []), ...branches.filter((b) => b.toLowerCase().includes(q))]
  const prResult = tab === 'prs' && prSearch.error === null ? (prSearch.found?.result ?? null) : null
  const issueResult =
    tab === 'issues' && issueSearch.error === null ? (issueSearch.found?.result ?? null) : null
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
        <span className="nw-chip-label">{value ?? 'Default branch'}</span>
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
                error={prSearch.error}
                resultQuery={prSearch.found?.query ?? ''}
                onRetry={() => {
                  prSearch.clear()
                  setAttempt((n) => n + 1)
                }}
                onOpenSettings={() => onOpenSettings('github')}
              />
            )}
            {tab === 'issues' && (
              <IssueState
                result={issueResult}
                error={issueSearch.error}
                resultQuery={issueSearch.found?.query ?? ''}
                onRetry={() => {
                  issueSearch.clear()
                  setAttempt((n) => n + 1)
                }}
                onOpenSettings={() => onOpenSettings('linear')}
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
                      <span className="nw-branch-name grow">{row.ref ?? 'Default branch'}</span>
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
