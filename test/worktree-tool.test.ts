import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const exec = promisify(execFile)
const roots: string[] = []
const cli = path.resolve('src/main/workspace/worktree-cli.mjs')
const cleanEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
async function git(root: string, ...args: string[]) {
  return (await exec('git', ['-C', root, ...args], { env: cleanEnv })).stdout.trim()
}
async function fixture() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'loom-worktree-tool-'))
  roots.push(root)
  await git(root, 'init', '-q', '-b', 'main')
  await git(
    root,
    '-c',
    'user.name=Loom Test',
    '-c',
    'user.email=loom@test.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'initial'
  )
  const env = { ...cleanEnv, LOOM_WORKSPACE_PATH: root, LOOM_WORKSPACE_ID: 'w1', LOOM_SESSION_ID: 's1' }
  return {
    root,
    env,
    run: (...args: string[]) => exec(process.execPath, [cli, 'worktree', ...args], { env })
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('creates a separate checkout, records its session, and preserves the original branch', async () => {
  const f = await fixture()
  const answer = JSON.parse((await f.run('create', '--branch', 'task/login', '--base', 'main')).stdout)
  expect(await git(f.root, 'branch', '--show-current')).toBe('main')
  expect(await git(answer.path, 'branch', '--show-current')).toBe('task/login')
  expect(answer.path.startsWith(path.join(f.root, '.context', 'worktrees') + path.sep)).toBe(true)
  const records = await readdir(path.join(f.root, '.context', 'worktrees', 'records'))
  const saved = JSON.parse(
    await readFile(path.join(f.root, '.context', 'worktrees', 'records', records[0]!), 'utf8')
  )
  expect(saved).toMatchObject({ workspaceId: 'w1', sessionId: 's1', branch: 'task/login', path: answer.path })
})

it('registers an existing worktree without modifying either checkout', async () => {
  const f = await fixture()
  const other = path.join(f.root, 'existing')
  await git(f.root, 'worktree', 'add', '-qb', 'task/existing', other)
  const answer = JSON.parse((await f.run('register', '--path', other)).stdout)
  expect(answer).toMatchObject({ sessionId: 's1', branch: 'task/existing', path: other })
  expect(await git(f.root, 'branch', '--show-current')).toBe('main')
})

it('rejects path escapes, flag injection, unrelated repositories, and symlinked storage', async () => {
  const f = await fixture()
  await expect(f.run('create', '--branch', '../outside')).rejects.toThrow()
  await expect(f.run('create', '--branch', '--force')).rejects.toThrow()
  const unrelated = await fixture()
  await expect(f.run('register', '--path', unrelated.root)).rejects.toThrow()
  await rm(path.join(f.root, '.context'), { recursive: true, force: true })
  await symlink(unrelated.root, path.join(f.root, '.context'))
  await expect(f.run('create', '--branch', 'task/escape')).rejects.toThrow()
  expect(await git(f.root, 'branch', '--show-current')).toBe('main')
})

it('requires a bound session and never guesses ownership from its working directory', async () => {
  const f = await fixture()
  await expect(
    exec(process.execPath, [cli, 'worktree', 'create', '--branch', 'task/no-owner'], {
      cwd: f.root,
      env: { ...f.env, LOOM_SESSION_ID: '' }
    })
  ).rejects.toThrow()
})
