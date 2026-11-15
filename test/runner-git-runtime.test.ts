import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import * as Git from '../src/main/git/run'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  Git.setGitRuntimeResolver(null)
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-runner-git-'))
  const checkout = path.join(root, 'container')
  await mkdir(checkout)
  const db = openDb(':memory:')
  db.prepare("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','Project',?,0)").run(root)
  db.prepare(
    "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at,runtime,state) VALUES ('w','p','work','loom/work',?,0,'container','initializing')"
  ).run(checkout)
  const runtime = { exec: vi.fn(async () => ({ stdout: 'confined\n', stderr: '' })) }
  const choose = vi.fn(() => runtime)
  const { createRunnerGit } = await import('../src/main/runner/git')
  const boundary = createRunnerGit({ db, dataRoot: root, runtimeFor: choose })
  cleanups.push(async () => {
    boundary.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, checkout, db, runtime, choose, boundary, createRunnerGit }
}

it('leaves trusted checkout initialization on the host and confines every later container state', async () => {
  const h = await fixture()
  expect(Git.gitRuntimeFor(h.checkout)).toBeNull()
  expect(h.choose).not.toHaveBeenCalled()
  for (const state of ['setting_up', 'ready', 'error']) {
    h.db.prepare('UPDATE workspaces SET state=? WHERE id=?').run(state, 'w')
    expect(Git.gitRuntimeFor(h.checkout)).toBe(h.runtime)
    expect(await Git.gitRaw(h.checkout, ['status'])).toBe('confined\n')
  }
  expect(h.runtime.exec).toHaveBeenCalledTimes(3)
})

it('routes descendant Git paths but does not confuse neighboring machine directories', async () => {
  const h = await fixture()
  h.db.prepare("UPDATE workspaces SET state='ready' WHERE id='w'").run()
  expect(Git.gitRuntimeFor(path.join(h.checkout, 'nested'))).toBe(h.runtime)
  expect(Git.gitRuntimeFor(`${h.checkout}-neighbor`)).toBeNull()
  expect(Git.gitRuntimeFor(h.root)).toBeNull()
})

it('retains known container fences after shutdown and replacement with an unrelated runner database', async () => {
  const h = await fixture()
  h.db.prepare("UPDATE workspaces SET state='ready' WHERE id='w'").run()
  expect(Git.gitRuntimeFor(h.checkout)).toBe(h.runtime)
  h.boundary.close()
  await expect(Git.gitRaw(h.checkout, ['status'])).rejects.toThrow(/runner|stopped|closed|unavailable/i)
  const other = await fixture()
  expect(Git.gitRuntimeFor(other.checkout)).toBeNull()
  await expect(Git.gitRaw(h.checkout, ['status'])).rejects.toThrow(/runner|stopped|closed|unavailable/i)
  expect(h.runtime.exec).not.toHaveBeenCalled()
})
