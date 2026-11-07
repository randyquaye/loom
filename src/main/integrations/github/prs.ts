import { z } from 'zod'
import type {
  PrCheck,
  PullRequestDetail,
  PullRequestSummary,
  ReviewDecision
} from '../../../shared/ipc-contract'
import { GhRequestError } from './errors'
import { ghExec, type GhExec } from './gh'
import type { GithubRepoRef } from './repo-ref'

/** Explicit allowlist: `--json` returns only the fields we name. */
const PR_LIST_FIELDS = [
  'number',
  'title',
  'headRefName',
  'baseRefName',
  'state',
  'isDraft',
  'url',
  'author',
  'updatedAt'
] as const

const PR_LIST_LIMIT = 50

const ghPullRequest = z.object({
  number: z.number().int(),
  title: z.string(),
  headRefName: z.string(),
  baseRefName: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  url: z.string(),
  author: z.object({ login: z.string() }).nullish(),
  updatedAt: z.string()
})

/**
 * Every flag takes the `--flag=value` form so a query beginning with "-" can never be
 * re-read as a flag, and the argv head is a literal: no caller-supplied string can
 * become a gh subcommand. `pr list` is the only subcommand this module can emit.
 */
export function buildPrListArgs(ref: GithubRepoRef, query: string | null): string[] {
  const args = [
    'pr',
    'list',
    `--repo=${ref.owner}/${ref.repo}`,
    '--state=open',
    `--limit=${PR_LIST_LIMIT}`,
    `--json=${PR_LIST_FIELDS.join(',')}`
  ]
  const trimmed = query?.trim() ?? ''
  if (trimmed !== '') args.push(`--search=${trimmed}`)
  return args
}

function toSummary(pr: z.infer<typeof ghPullRequest>): PullRequestSummary {
  const at = Date.parse(pr.updatedAt)
  return {
    number: pr.number,
    title: pr.title,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    state: pr.state.toLowerCase() as PullRequestSummary['state'],
    isDraft: pr.isDraft,
    url: pr.url,
    author: pr.author?.login ?? null,
    updatedAt: Number.isNaN(at) ? 0 : at
  }
}

/** gh's own process output is a system boundary, so it is validated before use. */
export function parsePrList(raw: string, args: readonly string[]): PullRequestSummary[] {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new GhRequestError(args, 'gh returned output that was not JSON')
  }
  const result = z.array(ghPullRequest).safeParse(json)
  if (!result.success) {
    throw new GhRequestError(
      args,
      `unexpected gh output shape: ${result.error.issues[0]?.message ?? 'unknown'}`
    )
  }
  return result.data.map(toSummary)
}

export async function listPullRequests(
  ref: GithubRepoRef,
  query: string | null,
  exec: GhExec = ghExec
): Promise<PullRequestSummary[]> {
  const args = buildPrListArgs(ref, query)
  return parsePrList(await exec(args), args)
}

/** The summary fields plus the two the workspace panel needs. */
const PR_DETAIL_FIELDS = [...PR_LIST_FIELDS, 'reviewDecision', 'statusCheckRollup'] as const

/**
 * GitHub's statusCheckRollup is a union of check runs (name/status/conclusion/detailsUrl)
 * and commit statuses (context/state/targetUrl). Both are accepted and normalised, so a
 * repository using either reports consistently.
 */
const ghStatusEntry = z.object({
  name: z.string().nullish(),
  context: z.string().nullish(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
  detailsUrl: z.string().nullish(),
  targetUrl: z.string().nullish()
})

const ghPullRequestDetail = ghPullRequest.extend({
  reviewDecision: z.string().nullish(),
  statusCheckRollup: z.array(ghStatusEntry).nullish()
})

const CHECK_FAILURES = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const CHECK_SKIPPED = new Set(['SKIPPED', 'NEUTRAL', 'STALE'])
const CHECK_PENDING = new Set(['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'])

function checkState(entry: z.infer<typeof ghStatusEntry>): PrCheck['state'] {
  const verdict = (entry.conclusion ?? entry.state ?? '').toUpperCase()
  if (verdict === 'SUCCESS') return 'success'
  if (CHECK_FAILURES.has(verdict)) return 'failure'
  if (verdict === 'CANCELLED') return 'cancelled'
  if (CHECK_SKIPPED.has(verdict)) return 'skipped'
  if (CHECK_PENDING.has(verdict)) return 'pending'
  // An unrecognised non-empty verdict fails safe: reporting a red check as still
  // pending would hide the one signal the panel exists to surface.
  if (verdict !== '') return 'failure'
  return 'pending'
}

function toCheck(entry: z.infer<typeof ghStatusEntry>): PrCheck {
  const name = entry.name ?? entry.context ?? ''
  return {
    name: name === '' ? 'check' : name,
    state: checkState(entry),
    detailsUrl: entry.detailsUrl ?? entry.targetUrl ?? null
  }
}

const REVIEW_DECISIONS: Record<string, ReviewDecision> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required'
}

function toReviewDecision(raw: string | null | undefined): ReviewDecision {
  if (raw === null || raw === undefined || raw === '') return 'none'
  return REVIEW_DECISIONS[raw.toUpperCase()] ?? 'none'
}

function toDetail(pr: z.infer<typeof ghPullRequestDetail>): PullRequestDetail {
  return {
    ...toSummary(pr),
    reviewDecision: toReviewDecision(pr.reviewDecision),
    checks: (pr.statusCheckRollup ?? []).map(toCheck)
  }
}

/**
 * Looks up the open PR whose head is `head`, for the workspace panel. `pr list` is used
 * rather than `pr view` on purpose: view exits 1 with prose on stderr when a branch has
 * no PR, whereas list exits 0 with an empty array, so "no PR yet" needs no error-text
 * matching and stays distinguishable from a real failure.
 */
export function buildPrHeadArgs(ref: GithubRepoRef, head: string): string[] {
  return [
    'pr',
    'list',
    `--repo=${ref.owner}/${ref.repo}`,
    '--state=open',
    '--limit=1',
    `--head=${head}`,
    `--json=${PR_DETAIL_FIELDS.join(',')}`
  ]
}

export function parsePrDetailList(raw: string, args: readonly string[]): PullRequestDetail[] {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new GhRequestError(args, 'gh returned output that was not JSON')
  }
  const result = z.array(ghPullRequestDetail).safeParse(json)
  if (!result.success) {
    throw new GhRequestError(
      args,
      `unexpected gh output shape: ${result.error.issues[0]?.message ?? 'unknown'}`
    )
  }
  return result.data.map(toDetail)
}

export async function findPullRequestForBranch(
  ref: GithubRepoRef,
  head: string | null,
  exec: GhExec = ghExec
): Promise<PullRequestDetail | null> {
  // head comes from `git rev-parse --abbrev-ref HEAD`, but a detached or empty HEAD has
  // no PR to find and must never reach gh where it could read as a flag.
  if (head === null || head === '' || head.startsWith('-')) return null
  const args = buildPrHeadArgs(ref, head)
  return (await parsePrDetailList(await exec(args), args))[0] ?? null
}
