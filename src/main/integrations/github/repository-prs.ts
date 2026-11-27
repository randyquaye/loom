import { z } from 'zod'
import type { PullRequestDetail } from '../../../shared/ipc-contract'
import type { RepositoryPullRequest } from '../../../shared/workspace-prs'
import { ghExec, type GhExec } from './gh'
import { parsePrDetailList } from './prs'
import type { GithubRepoRef } from './repo-ref'

interface Entry<T> {
  value?: T
  etag?: string
  error?: unknown
  expires: number
  attempted: number
  failures: number
  pending?: Promise<T>
}

function requestCache<T>(now: () => number) {
  const entries = new Map<string, Entry<T>>()
  return async (
    key: string,
    load: (etag?: string) => Promise<{ value?: T; etag?: string }>,
    force = false
  ): Promise<T> => {
    let entry = entries.get(key)
    if (entry?.pending) return entry.pending
    if (entry && now() < entry.expires) {
      if (entry.error) throw entry.error
      if (entry.value !== undefined && (!force || now() - entry.attempted < 10000)) return entry.value
    }
    if (!entry) {
      if (entries.size >= 256) {
        const removable = [...entries].find(([, candidate]) => !candidate.pending)
        if (removable) entries.delete(removable[0])
      }
      entry = { expires: 0, attempted: now(), failures: 0 }
      entries.set(key, entry)
    }
    const current = entry
    current.attempted = now()
    current.pending = load(current.etag)
      .then((answer) => {
        if (answer.value !== undefined) current.value = answer.value
        if (current.value === undefined) throw new Error('GitHub returned no cached PR result')
        if (answer.etag) current.etag = answer.etag
        delete current.error
        current.failures = 0
        current.expires = now() + 120000
        return current.value
      })
      .catch((error: unknown) => {
        current.error = error
        current.failures++
        const limited = /429|rate limit|403/i.test(String(error))
        current.expires =
          now() + Math.min(900000, (limited ? 300000 : 30000) * 2 ** Math.min(current.failures - 1, 5))
        throw error
      })
      .finally(() => {
        delete current.pending
      })
    return current.pending
  }
}

const restPr = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable(),
  draft: z.boolean().optional(),
  updated_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
  base: z.object({ ref: z.string() })
})

/** One index per repository AND credential owner, shared by the sidebar and workspace panel. */
export function createRepositoryPrCache(now: () => number = Date.now) {
  const indexes = requestCache<RepositoryPullRequest[]>(now)
  const details = requestCache<PullRequestDetail>(now)
  const key = (ref: GithubRepoRef, scope: string, exec: GhExec) =>
    JSON.stringify([scope, exec.cacheKey ?? 'machine', ref.owner.toLowerCase(), ref.repo.toLowerCase()])
  return {
    list(ref: GithubRepoRef, scope: string, exec: GhExec = ghExec, force = false) {
      return indexes(
        key(ref, scope, exec),
        async (etag) => {
          const args = [
            'api',
            '--method=GET',
            '--include',
            `repos/${ref.owner}/${ref.repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`
          ]
          if (etag) args.push('--header', `If-None-Match: ${etag}`)
          const raw = await exec(args)
          const status = Number(raw.match(/^HTTP\/\S+\s+(\d+)/)?.[1])
          if (status === 304) return {}
          const split = raw.search(/\r?\n\r?\n/)
          if (split < 0) throw new Error('GitHub returned no HTTP headers')
          const headers = raw.slice(0, split)
          if (status !== 200) throw new Error(`GitHub answered HTTP ${status}`)
          const body = raw.slice(split).replace(/^\r?\n\r?\n/, '')
          const value = z
            .array(restPr)
            .parse(JSON.parse(body))
            .map((pr): RepositoryPullRequest => ({
              number: pr.number,
              title: pr.title,
              url: pr.html_url,
              headRefName: pr.head.ref,
              headRepository: pr.head.repo?.full_name ?? null,
              baseRefName: pr.base.ref,
              state: pr.merged_at ? 'merged' : pr.state,
              isDraft: pr.draft ?? false,
              author: pr.user?.login ?? null,
              updatedAt: Date.parse(pr.updated_at) || 0
            }))
          const nextEtag = headers.match(/^etag:\s*(.+)$/im)?.[1]?.trim()
          return nextEtag ? { value, etag: nextEtag } : { value }
        },
        force
      )
    },
    detail(ref: GithubRepoRef, number: number, scope: string, exec: GhExec = ghExec, force = false) {
      return details(
        `${key(ref, scope, exec)}:${number}`,
        async () => {
          const args = [
            'pr',
            'view',
            String(number),
            `--repo=${ref.owner}/${ref.repo}`,
            '--json=number,title,headRefName,baseRefName,state,isDraft,url,author,updatedAt,reviewDecision,statusCheckRollup'
          ]
          const value = parsePrDetailList(JSON.stringify([JSON.parse(await exec(args))]), args)[0]
          if (!value) throw new Error('GitHub returned no PR details')
          return { value }
        },
        force
      )
    }
  }
}
