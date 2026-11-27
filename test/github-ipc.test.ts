import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, input: unknown) => unknown
const handlers = new Map<string, Handler>()
const { indexPrs, detailPr, branches } = vi.hoisted(() => ({
  indexPrs: vi.fn(),
  detailPr: vi.fn(),
  branches: vi.fn()
}))
vi.mock('../src/main/integrations/github/repository-prs', () => ({
  createRepositoryPrCache: () => ({ list: indexPrs, detail: detailPr })
}))
vi.mock('../src/main/workspace/worktree-tracking', () => ({ refreshWorkspaceBranches: branches }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler): void => {
      handlers.set(channel, fn)
    }
  },
  dialog: { showSaveDialog: vi.fn() }
}))

// Both integration modules are replaced so no test ever shells out to gh or the network.
vi.mock('../src/main/integrations/github/gh', () => ({ ghAuthState: vi.fn(), ghExec: vi.fn() }))
vi.mock('../src/main/integrations/github/prs', () => ({
  listPullRequests: vi.fn(),
  findPullRequestForBranch: vi.fn()
}))
// The workspace panel reads the worktree's live HEAD; no real worktree is created here.
vi.mock('../src/main/git/branches', () => ({ currentBranch: vi.fn(), listBranches: vi.fn() }))

import { openDb } from '../src/main/db'
import { currentBranch } from '../src/main/git/branches'
import { GhNotAuthenticatedError, GhNotInstalledError } from '../src/main/integrations/github/errors'
import { ghAuthState } from '../src/main/integrations/github/gh'
import { listPullRequests } from '../src/main/integrations/github/prs'
import { registerIpc, setTrustedOrigin } from '../src/main/ipc/index'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import type { IntegrationsStatus, PullRequestListResult, WorkspacePrResult } from '../src/shared/ipc-contract'

const listPrs = vi.mocked(listPullRequests)
const findPr = detailPr
const headBranch = vi.mocked(currentBranch)
const authState = vi.mocked(ghAuthState)

const PR = {
  number: 42,
  title: 'Fix the flux capacitor',
  headRefName: 'loom/fix-flux',
  baseRefName: 'main',
  state: 'open' as const,
  isDraft: false,
  url: 'https://github.com/octocat/hello-world/pull/42',
  author: 'randyquaye',
  updatedAt: 1_762_338_030_000
}

function seededDb() {
  const db = openDb(':memory:')
  const insert = db.prepare(
    'INSERT INTO projects (id, name, repo_path, remote_url, created_at) VALUES (?, ?, ?, ?, ?)'
  )
  insert.run('github', 'hello-world', '/tmp/hello', 'git@github.com:octocat/hello-world.git', 1)
  insert.run('gitlab', 'other', '/tmp/other', 'https://gitlab.com/o/r.git', 1)
  insert.run('bare', 'quickstart', '/tmp/bare', null, 1)
  // The worktree path is never stat'd: currentBranch is mocked, so a fake path is enough.
  db.prepare(
    'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('w-github', 'github', 'fix-flux', 'loom/fix-flux', '/tmp/wt/fix-flux', 1)
  db.prepare(
    'INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('w-gitlab', 'gitlab', 'other', 'loom/other', '/tmp/wt/other', 1)
  return db
}

beforeEach(() => {
  handlers.clear()
  listPrs.mockReset()
  findPr.mockReset()
  indexPrs.mockReset().mockResolvedValue([{ ...PR, headRepository: 'octocat/hello-world' }])
  branches.mockReset().mockImplementation(async (_db, workspace) => {
    const branch = await currentBranch(workspace.worktreePath)
    return branch ? [{ branch, path: workspace.worktreePath, sessionId: '', source: 'workspace' }] : []
  })
  headBranch.mockReset()
  headBranch.mockResolvedValue('loom/fix-flux')
  authState.mockReset()
  setTrustedOrigin('file://')
  const secrets = createSecretStore(
    path.join(mkdtempSync(path.join(tmpdir(), 'loom-ghipc-')), 'secrets.enc'),
    aesGcmCipher(randomBytes(32))
  )
  registerIpc({ db: seededDb(), secrets, dataRoot: tmpdir() })
})

/** Invokes a registered handler the way Electron would, through the zod input gate. */
async function call<T>(channel: string, input: unknown): Promise<T> {
  const fn = handlers.get(channel)
  if (fn === undefined) throw new Error(`no handler registered for ${channel}`)
  return (await fn({ senderFrame: { url: 'file://index.html' } }, input)) as T
}

function prs(projectId: string, query: string | null = null) {
  return call<PullRequestListResult>('github:prs', { projectId, query })
}

describe('github:prs', () => {
  it('lists PRs for a project whose origin is on github.com', async () => {
    listPrs.mockResolvedValue([PR])
    await expect(prs('github')).resolves.toEqual({ kind: 'ok', pullRequests: [PR] })
    expect(listPrs).toHaveBeenCalledWith({ owner: 'octocat', repo: 'hello-world' }, null)
  })

  it('forwards the search query untouched', async () => {
    listPrs.mockResolvedValue([])
    await prs('github', 'flux')
    expect(listPrs).toHaveBeenCalledWith({ owner: 'octocat', repo: 'hello-world' }, 'flux')
  })

  it('reports a non-GitHub origin as no-remote without calling gh', async () => {
    await expect(prs('gitlab')).resolves.toEqual({ kind: 'no-remote' })
    expect(listPrs).not.toHaveBeenCalled()
  })

  it('reports a project with no origin at all as no-remote', async () => {
    await expect(prs('bare')).resolves.toEqual({ kind: 'no-remote' })
    expect(listPrs).not.toHaveBeenCalled()
  })

  it('turns a missing gh binary into an install hint, not an empty list', async () => {
    listPrs.mockRejectedValue(new GhNotInstalledError())
    const result = await prs('github')
    expect(result.kind).toBe('not-installed')
    if (result.kind === 'not-installed') expect(result.hint).toMatch(/brew install gh/)
  })

  it('turns a missing login into a sign-in hint', async () => {
    listPrs.mockRejectedValue(new GhNotAuthenticatedError())
    const result = await prs('github')
    expect(result.kind).toBe('not-authenticated')
    if (result.kind === 'not-authenticated') expect(result.hint).toMatch(/gh auth login/)
  })

  it('passes an unexpected failure through as failed, keeping the code prefix', async () => {
    listPrs.mockRejectedValue(new Error('GH_REQUEST_FAILED: gh pr list: HTTP 500'))
    const result = await prs('github')
    expect(result).toEqual({ kind: 'failed', message: 'GH_REQUEST_FAILED: gh pr list: HTTP 500' })
  })

  it('rejects an unknown project id', async () => {
    await expect(prs('nope')).rejects.toThrow()
  })

  it('rejects a query past the schema limit at the IPC boundary', async () => {
    await expect(prs('github', 'a'.repeat(201))).rejects.toThrow()
    expect(listPrs).not.toHaveBeenCalled()
  })
})

describe('integrations:status', () => {
  function status() {
    return call<IntegrationsStatus>('integrations:status', undefined)
  }

  it('reports the signed-in GitHub account', async () => {
    authState.mockResolvedValue({ installed: true, account: 'randyquaye' })
    expect((await status()).github).toEqual({ state: 'ready', account: 'randyquaye' })
  })

  it('reports gh as missing when the binary is not on PATH', async () => {
    authState.mockResolvedValue({ installed: false, account: null })
    const { github } = await status()
    expect(github.state).toBe('not-installed')
  })

  it('reports installed-but-signed-out when there is no github.com account', async () => {
    authState.mockResolvedValue({ installed: true, account: null })
    expect((await status()).github.state).toBe('not-authenticated')
  })

  it('degrades to not-installed if the probe itself throws', async () => {
    authState.mockRejectedValue(new Error('boom'))
    expect((await status()).github.state).toBe('not-installed')
  })

  it('reports Linear as awaiting a key while none is stored', async () => {
    authState.mockResolvedValue({ installed: true, account: 'randyquaye' })
    const { linear } = await status()
    expect(linear.state).toBe('needs-key')
  })
})

describe('github:workspacePr', () => {
  const DETAIL = {
    ...PR,
    reviewDecision: 'review_required' as const,
    checks: [{ name: 'ci/test', state: 'success' as const, detailsUrl: 'https://ci.example/1' }]
  }

  function workspacePr(workspaceId: string) {
    return call<WorkspacePrResult>('github:workspacePr', { workspaceId })
  }

  it('looks up the PR for the worktree branch the workspace is actually on', async () => {
    headBranch.mockResolvedValue('loom/fix-flux')
    findPr.mockResolvedValue(DETAIL)

    await expect(workspacePr('w-github')).resolves.toMatchObject({
      kind: 'ok',
      pullRequest: DETAIL,
      state: 'open'
    })
    expect(headBranch).toHaveBeenCalledWith('/tmp/wt/fix-flux')
    expect(indexPrs).toHaveBeenCalledTimes(1)
  })

  it('reports no PR as ok with null, not as a failure', async () => {
    indexPrs.mockResolvedValue([])

    await expect(workspacePr('w-github')).resolves.toMatchObject({
      kind: 'ok',
      pullRequest: null,
      pullRequests: []
    })
  })

  it('reports no PR for a detached HEAD without inventing one', async () => {
    headBranch.mockResolvedValue(null)
    findPr.mockResolvedValue(null)

    await expect(workspacePr('w-github')).resolves.toMatchObject({ kind: 'ok', pullRequest: null })
    expect(findPr).not.toHaveBeenCalled()
  })

  it('reports a project whose origin is not on github.com as no-remote', async () => {
    await expect(workspacePr('w-gitlab')).resolves.toEqual({ kind: 'no-remote' })
    expect(findPr).not.toHaveBeenCalled()
  })

  it('maps a missing gh binary and a missing login onto their own hints', async () => {
    findPr.mockRejectedValueOnce(new GhNotInstalledError())
    expect((await workspacePr('w-github')).kind).toBe('not-installed')

    findPr.mockRejectedValueOnce(new GhNotAuthenticatedError())
    expect((await workspacePr('w-github')).kind).toBe('not-authenticated')
  })

  it('passes an unexpected failure through with its code prefix', async () => {
    findPr.mockRejectedValue(new Error('GH_REQUEST_FAILED: gh pr list: HTTP 502'))
    await expect(workspacePr('w-github')).resolves.toEqual({
      kind: 'failed',
      message: 'GH_REQUEST_FAILED: gh pr list: HTTP 502'
    })
  })

  it('rejects an unknown workspace id', async () => {
    await expect(workspacePr('nope')).rejects.toThrow()
  })

  it('finds a PR from another registered session branch, keeping the original merged PR', async () => {
    branches.mockResolvedValue([
      { branch: 'loom/fix-flux', sessionId: '' },
      { branch: 'task/pr7', sessionId: 's1' }
    ])
    indexPrs.mockResolvedValue([
      { ...PR, state: 'merged', headRepository: 'octocat/hello-world' },
      { ...PR, number: 7, headRefName: 'task/pr7', headRepository: 'octocat/hello-world' }
    ])
    findPr.mockResolvedValue({ ...DETAIL, number: 7, headRefName: 'task/pr7' })
    const result = await workspacePr('w-github')
    expect(result).toMatchObject({
      kind: 'ok',
      state: 'open',
      pullRequest: { number: 7 },
      pullRequests: [{ number: 7, sessionIds: ['s1'] }, { number: 42 }]
    })
  })
})
