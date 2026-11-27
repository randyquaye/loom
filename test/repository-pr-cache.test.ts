import { expect, it, vi } from 'vitest'
import { createRepositoryPrCache } from '../src/main/integrations/github/repository-prs'
import { aggregateWorkspacePrs } from '../src/shared/workspace-prs'

const ref = { owner: 'acme', repo: 'demo' }
const rawPr = (number: number, branch: string, state = 'open', merged_at: string | null = null) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/acme/demo/pull/${number}`,
  state,
  merged_at,
  draft: false,
  updated_at: '2026-11-26T12:00:00Z',
  user: { login: 'dev' },
  head: { ref: branch, repo: { full_name: 'acme/demo' } },
  base: { ref: 'main' }
})
const response = (prs: unknown[], etag = '"first"') =>
  `HTTP/2.0 200 OK\r\nETag: ${etag}\r\n\r\n${JSON.stringify(prs)}`

it('shares in-flight requests and cached results across consumers, isolated by account', async () => {
  const cache = createRepositoryPrCache()
  const exec = vi.fn(async (_args: readonly string[]) => response([rawPr(7, 'task/new')]))
  const results = await Promise.all([cache.list(ref, 'a', exec), cache.list(ref, 'a', exec)])
  expect(results[0]).toEqual(results[1])
  await cache.list(ref, 'a', exec)
  expect(exec).toHaveBeenCalledTimes(1)
  await cache.list(ref, 'b', exec)
  expect(exec).toHaveBeenCalledTimes(2)
})

it('conditionally refreshes unchanged PRs after expiry and reuses a 304 response', async () => {
  let now = 0
  const cache = createRepositoryPrCache(() => now)
  const exec = vi.fn(async (_args: readonly string[]) => response([rawPr(7, 'task/new')]))
  const first = await cache.list(ref, 'a', exec)
  now = 120_001
  exec.mockResolvedValueOnce('HTTP/2.0 304 Not Modified\r\n\r\n')
  expect(await cache.list(ref, 'a', exec)).toEqual(first)
  expect(exec.mock.calls[1]?.[0]).toContain('If-None-Match: "first"')
})

it('backs off failures instead of repeatedly querying or reporting no PR', async () => {
  let now = 0
  const cache = createRepositoryPrCache(() => now)
  const exec = vi.fn(async () => {
    throw new Error('HTTP 429 rate limit')
  })
  await expect(cache.list(ref, 'a', exec)).rejects.toThrow('429')
  now = 10_000
  await expect(cache.list(ref, 'a', exec)).rejects.toThrow('429')
  expect(exec).toHaveBeenCalledTimes(1)
})

it('matches registered branches, gives open PRs precedence, and never treats closed PRs as merged', async () => {
  const cache = createRepositoryPrCache()
  const prs = await cache.list(ref, 'a', async () =>
    response([
      rawPr(2, 'original', 'closed', '2026-11-14T12:00:00Z'),
      rawPr(7, 'task/new'),
      rawPr(8, 'unrelated'),
      { ...rawPr(9, 'task/new'), head: { ref: 'task/new', repo: { full_name: 'stranger/fork' } } }
    ])
  )
  const associated = aggregateWorkspacePrs(prs, ['original', 'task/new'], 'acme/demo')
  expect(associated.pullRequests.map((pr) => pr.number)).toEqual([7, 2])
  expect(associated.state).toBe('open')
  expect(aggregateWorkspacePrs(prs, ['original'], 'acme/demo').state).toBe('merged')
  const closed = await cache.list(ref, 'b', async () => response([rawPr(10, 'task/closed', 'closed')]))
  expect(aggregateWorkspacePrs(closed, ['task/closed'], 'acme/demo').state).toBeNull()
})
