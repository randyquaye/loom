import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  PrCheck,
  PullRequestDetail,
  ReviewDecision,
  WorkspacePrResult
} from '../../../shared/ipc-contract'
import { clampInWindow, useCloseOnAnchorMove, WINDOW_EDGE } from '../ui/anchor'
import './pr-status.css'

type Tone = 'ok' | 'warn' | 'danger' | 'default'
type Aggregate = 'failure' | 'pending' | 'success' | 'neutral'

const AGGREGATE: Record<Aggregate, { glyph: string; tone: Tone; label: string }> = {
  failure: { glyph: '✕', tone: 'danger', label: 'checks failing' },
  pending: { glyph: '◌', tone: 'warn', label: 'checks pending' },
  success: { glyph: '✓', tone: 'ok', label: 'checks passed' },
  neutral: { glyph: '–', tone: 'default', label: 'no check results' }
}

const CHECK: Record<PrCheck['state'], { glyph: string; tone: Tone; count: string }> = {
  success: { glyph: '✓', tone: 'ok', count: 'passed' },
  failure: { glyph: '✕', tone: 'danger', count: 'failing' },
  pending: { glyph: '◌', tone: 'warn', count: 'pending' },
  cancelled: { glyph: '⊘', tone: 'default', count: 'cancelled' },
  skipped: { glyph: '–', tone: 'default', count: 'skipped' }
}

const POLL_MS = 60_000

/** Gap between the chip and the popover. */
const GAP = 8

const SUMMARY_ORDER: PrCheck['state'][] = ['success', 'failure', 'pending', 'cancelled', 'skipped']

function reviewLabel(decision: ReviewDecision): { text: string; tone: Tone } | null {
  switch (decision) {
    case 'approved':
      return { text: 'approved', tone: 'ok' }
    case 'changes_requested':
      return { text: 'changes requested', tone: 'danger' }
    case 'review_required':
      return { text: 'review required', tone: 'warn' }
    case 'none':
      return null
  }
}

/** Cancelled and skipped checks never count as passing: a rollup of only those reads neutral. */
function aggregate(checks: PrCheck[]): Aggregate {
  if (checks.some((c) => c.state === 'failure')) return 'failure'
  if (checks.some((c) => c.state === 'pending')) return 'pending'
  if (checks.some((c) => c.state === 'success')) return 'success'
  return 'neutral'
}

function checksSummary(checks: PrCheck[]): string {
  if (checks.length === 0) return 'No checks reported'
  return SUMMARY_ORDER.map((state) => {
    const n = checks.filter((c) => c.state === state).length
    return n === 0 ? null : `${n} ${CHECK[state].count}`
  })
    .filter((part) => part !== null)
    .join(' · ')
}

/**
 * Topbar chip for the open pull request on this workspace's branch, with a popover listing the
 * review decision and checks. Fetched on navigation, when the popover opens, on refresh, on window
 * focus, and every minute while the document is visible; the last two skip while a fetch is in
 * flight.
 */
export function PrStatus({ workspaceId, ready }: { workspaceId: string; ready: boolean }) {
  const [attempt, setAttempt] = useState(0)
  // Keyed by workspace and attempt so a stale answer never shows and loading is derived.
  const [fetched, setFetched] = useState<{
    workspaceId: string
    attempt: number
    result: WorkspacePrResult
  } | null>(null)
  // Keyed by workspace so navigating away closes the popover without an effect.
  const [openFor, setOpenFor] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const refreshRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: WINDOW_EDGE, top: WINDOW_EDGE })
  // Ids the newest request; cleared when that one settles, so a superseded request cannot clear it.
  const inFlight = useRef<number | null>(null)
  const requests = useRef(0)
  // What the last answer was, so background refreshes can skip hopeless cases.
  const lastKind = useRef<WorkspacePrResult['kind'] | null>(null)

  // No worktree before `ready`, so a call would fail for reasons unrelated to GitHub.
  useEffect(() => {
    if (!ready) return
    let disposed = false
    const request = ++requests.current
    inFlight.current = request
    window.loom.github
      .workspacePr(workspaceId)
      .then((result) => {
        lastKind.current = result.kind
        if (!disposed) setFetched({ workspaceId, attempt, result })
      })
      .catch((err: unknown) => {
        lastKind.current = 'failed'
        if (!disposed) setFetched({ workspaceId, attempt, result: { kind: 'failed', message: String(err) } })
      })
      .finally(() => {
        if (inFlight.current === request) inFlight.current = null
      })
    return () => {
      disposed = true
    }
  }, [workspaceId, ready, attempt])

  const refresh = useCallback((force: boolean) => {
    if (!force && inFlight.current !== null) return
    setAttempt((n) => n + 1)
  }, [])

  // Background refreshes: each would spawn `gh`, so none while hidden or already fetching,
  // and none at all for a project with no GitHub remote. A missing or signed-out gh still
  // gets the focus refetch, since signing in happens outside the app.
  useEffect(() => {
    if (!ready) return
    const tick = (onFocus: boolean) => {
      if (document.visibilityState !== 'visible') return
      const kind = lastKind.current
      if (kind === 'no-remote') return
      if (!onFocus && (kind === 'not-installed' || kind === 'not-authenticated')) return
      refresh(false)
    }
    const timer = window.setInterval(() => tick(false), POLL_MS)
    const onFocus = () => tick(true)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [ready, refresh])

  const current = fetched?.workspaceId === workspaceId ? fetched : null
  const loading = current === null || current.attempt !== attempt
  const pr: PullRequestDetail | null = current?.result.kind === 'ok' ? current.result.pullRequest : null
  const popoverOpen = openFor === workspaceId && pr !== null

  // Portalled to body: inside the topbar the glass .main's stacking context would keep it under
  // .rightpane. Measured before paint, right-aligned to the chip and clamped inside the window.
  useLayoutEffect(() => {
    if (!popoverOpen) return
    const rect = triggerRef.current?.getBoundingClientRect()
    const popover = popoverRef.current
    if (rect === undefined || popover === null) return
    const { width, height } = popover.getBoundingClientRect()
    setPosition({
      left: clampInWindow(rect.right - width, width, window.innerWidth),
      top: clampInWindow(rect.bottom + GAP, height, window.innerHeight)
    })
  }, [popoverOpen])

  useEffect(() => {
    if (!popoverOpen) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) === true || popoverRef.current?.contains(target) === true)
        return
      setOpenFor(null)
    }
    document.addEventListener('mousedown', onDown)
    // Deferred a frame so the popover is mounted before it takes focus.
    const frame = requestAnimationFrame(() => refreshRef.current?.focus())
    return () => {
      document.removeEventListener('mousedown', onDown)
      cancelAnimationFrame(frame)
    }
  }, [popoverOpen])

  const dismiss = useCallback(() => setOpenFor(null), [])
  useCloseOnAnchorMove(triggerRef, dismiss, popoverOpen)

  // Blockers render nothing on purpose. A project not on GitHub would otherwise carry a permanent
  // dead chip, and a missing or signed-out gh would nag identically on every workspace; Settings →
  // Integrations and the new-workspace PRs tab surface those with a remedy.
  if (!ready || current === null || current.result.kind !== 'ok') return null

  if (pr === null) {
    return (
      <span
        className="badge pr-status-none"
        title="This branch has no open pull request yet. Loom never pushes branches."
      >
        No PR
      </span>
    )
  }

  const agg = AGGREGATE[aggregate(pr.checks)]
  const review = reviewLabel(pr.reviewDecision)
  const chipLabel = [
    `Pull request #${pr.number}`,
    agg.label,
    ...(review === null ? [] : [review.text]),
    ...(pr.isDraft ? ['draft'] : [])
  ].join(', ')

  function close(refocus: boolean) {
    setOpenFor(null)
    if (refocus) triggerRef.current?.focus()
  }

  return (
    <div className="popover-wrap pr-status">
      <button
        ref={triggerRef}
        type="button"
        className="badge pr-status-chip"
        aria-haspopup="dialog"
        aria-expanded={popoverOpen}
        aria-label={chipLabel}
        title={pr.title}
        onClick={() => {
          if (popoverOpen) close(false)
          else {
            setOpenFor(workspaceId)
            refresh(true)
          }
        }}
      >
        <span className="pr-status-number">#{pr.number}</span>
        <span className="pr-status-glyph" data-tone={agg.tone} aria-hidden="true">
          {agg.glyph}
        </span>
        {review !== null && (
          <span className="pr-status-review" data-tone={review.tone}>
            {review.text}
          </span>
        )}
        {pr.isDraft && <span className="pr-status-draft">Draft</span>}
      </button>
      {popoverOpen &&
        createPortal(
          <div
            ref={popoverRef}
            className="popover elevated pr-status-popover"
            style={{ position: 'fixed', left: position.left, top: position.top }}
            role="dialog"
            aria-label={`Pull request #${pr.number}`}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Keep Escape local: nothing above the popover should close with it.
                e.stopPropagation()
                close(true)
              }
            }}
          >
            <div className="pr-status-head">
              <div className="pr-status-title">
                <span className="pr-status-number">#{pr.number}</span> {pr.title}
              </div>
              <div className="pr-status-refs" title={`${pr.headRefName} → ${pr.baseRefName}`}>
                {pr.headRefName} → {pr.baseRefName}
              </div>
            </div>
            <div className="pr-status-line">
              {review === null ? (
                <span className="muted">No review decision</span>
              ) : (
                <>
                  <span className="muted">Review</span>
                  <span className="pr-status-review" data-tone={review.tone}>
                    {review.text}
                  </span>
                </>
              )}
              {pr.isDraft && <span className="pr-status-draft">Draft</span>}
            </div>
            <div className="pr-status-line">
              <span className="pr-status-glyph" data-tone={agg.tone} aria-hidden="true">
                {agg.glyph}
              </span>
              <span className="muted">{checksSummary(pr.checks)}</span>
            </div>
            {pr.checks.length > 0 && (
              <ul className="pr-status-checks" aria-label="Checks">
                {pr.checks.map((check, i) => (
                  <li key={`${check.name}-${i}`} className="pr-status-check">
                    <span
                      className="pr-status-glyph"
                      data-tone={CHECK[check.state].tone}
                      role="img"
                      aria-label={CHECK[check.state].count}
                      title={CHECK[check.state].count}
                    >
                      {CHECK[check.state].glyph}
                    </span>
                    <span className="pr-status-check-name" title={check.name}>
                      {check.name}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="pr-status-foot">
              <button
                ref={refreshRef}
                type="button"
                className="btn btn-ghost"
                aria-busy={loading}
                onClick={() => refresh(true)}
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (!pr.url.startsWith('https://')) return
                  void window.loom.shell.openExternal(pr.url)
                  close(false)
                }}
              >
                Open in GitHub
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
