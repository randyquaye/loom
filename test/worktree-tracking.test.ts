import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { openDb } from '../src/main/db'
import { getWorkspaceOrThrow } from '../src/main/db/repos/workspaces'
import { machineRuntime } from '../src/main/runtime/machine'
import { prepareWorktreeTool } from '../src/main/workspace/worktree-tool'
import { refreshWorkspaceBranches } from '../src/main/workspace/worktree-tracking'

const exec = promisify(execFile)
const cleanEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'loom-tracked-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const git = async (...args: string[]) =>
    (await exec('git', ['-C', root, ...args], { env: cleanEnv })).stdout.trim()
  await git('init', '-q', '-b', 'original')
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'init'
  )
  const db = openDb(':memory:')
  cleanup.push(() => {
    db.close()
  })
  db.prepare('INSERT INTO projects(id,name,repo_path,created_at) VALUES(?,?,?,?)').run(
    'p',
    'project',
    root,
    1
  )
  db.prepare(
    'INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at) VALUES(?,?,?,?,?,?)'
  ).run('w', 'p', 'workspace', 'original', root, 1)
  db.prepare(
    'INSERT INTO sessions(id,workspace_id,backend,model,effort,title,created_at) VALUES(?,?,?,?,?,?,?)'
  ).run('s', 'w', 'codex', 'model', 'high', 'Fix login', 1)
  return { root, git, db, workspace: getWorkspaceOrThrow(db, 'w') }
}

it('discovers nested worktrees without claiming other workspaces, and retains observed branch history', async () => {
  const f = await fixture()
  const nested = path.join(f.root, '.context', 'pr-preparation', 'tree')
  await f.git('worktree', 'add', '-qb', 'task/pr7', nested)
  const outside = await mkdtemp(path.join(await realpath(tmpdir()), 'loom-other-'))
  cleanup.push(() => rm(outside, { recursive: true, force: true }))
  await f.git('worktree', 'add', '-qb', 'other/workspace', outside)
  const seen = await refreshWorkspaceBranches(f.db, f.workspace)
  expect(seen.map((row) => row.branch).sort()).toEqual(['original', 'task/pr7'])
  await f.git('worktree', 'remove', nested)
  expect((await refreshWorkspaceBranches(f.db, f.workspace)).map((row) => row.branch)).toContain('task/pr7')
})

it('installs a usable shell helper and imports its session ownership', async () => {
  const f = await fixture()
  const env = await prepareWorktreeTool(machineRuntime, f.workspace, 's', { GIT_CONFIG_GLOBAL: '/dev/null' })
  expect(env.LOOM_SESSION_ID).toBe('s')
  const created = JSON.parse(
    (
      await exec('sh', ['-c', 'loom worktree create --branch task/registered --base original'], {
        cwd: f.root,
        env: { ...cleanEnv, ...env }
      })
    ).stdout
  )
  expect(created.branch).toBe('task/registered')
  const seen = await refreshWorkspaceBranches(f.db, f.workspace)
  expect(seen).toContainEqual(
    expect.objectContaining({ branch: 'task/registered', sessionId: 's', source: 'registered' })
  )
})
