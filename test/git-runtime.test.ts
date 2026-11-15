import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import * as Git from '../src/main/git/run'
import { diffFor, listChanges } from '../src/main/git/status'
import { saveCheckpoint } from '../src/main/git/checkpoint'
import type { WorkspaceRuntime } from '../src/main/runtime/types'

const run = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  Git.setGitRuntimeResolver(null)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-git-routing-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  await mkdir(repo)
  const git = (...args: string[]) => run('git', ['-C', repo, ...args])
  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', 'Fixture')
  await git('config', 'user.email', 'fixture@loom.invalid')
  await git('config', 'commit.gpgsign', 'false')
  await writeFile(path.join(repo, 'payload.txt'), 'before\n')
  await git('add', 'payload.txt')
  await git('commit', '-q', '-m', 'fixture')
  const marker = path.join(root, 'outside-host-marker')
  const filter = path.join(repo, '.git', 'fixture-clean.sh')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(filter, `#!/bin/sh\nprintf host-executed > ${quote(marker)}\ncat\n`)
  await chmod(filter, 0o700)
  await git('config', 'filter.fixture.clean', quote(filter))
  await git('config', 'filter.fixture.required', 'true')
  await writeFile(path.join(repo, '.gitattributes'), '*.txt filter=fixture\n')
  await writeFile(path.join(repo, 'payload.txt'), 'after\n')
  return { root, repo, marker }
}

function confinedGit(repo: string) {
  const execute = vi.fn<WorkspaceRuntime['exec']>().mockImplementation(async (file, args) => {
    if (file === 'mktemp') return { stdout: '/tmp/loom-ckpt-fixture123\n', stderr: '' }
    if (file === 'rm') return { stdout: '', stderr: '' }
    if (file !== 'git') throw new Error('Unexpected fixture executable')
    const command = args.slice(args.indexOf('-C') + 2)
    if (command[0] === 'rev-parse') {
      if (command.includes('--show-toplevel')) return { stdout: `${repo}\n`, stderr: '' }
      if (command.includes('--git-dir')) return { stdout: '.git\n', stderr: '' }
      return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
    }
    if (command[0] === 'status') return { stdout: ' M payload.txt\0', stderr: '' }
    if (command[0] === 'diff')
      return { stdout: 'diff --git a/payload.txt b/payload.txt\n-before\n+after\n', stderr: '' }
    if (command[0] === 'write-tree' || command[0] === 'commit-tree')
      return { stdout: `${'b'.repeat(40)}\n`, stderr: '' }
    return { stdout: '', stderr: '' }
  })
  return { exec: execute }
}

it('runs container status, diff, and checkpoint filters through its runtime without host execution', async () => {
  const h = await repository()
  const runtime = confinedGit(h.repo)
  Git.setGitRuntimeResolver((cwd) => (cwd === h.repo ? runtime : null))
  expect(await listChanges(h.repo)).toEqual([
    { path: 'payload.txt', status: 'modified', staged: false, unstaged: true }
  ])
  expect(await diffFor(h.repo, 'payload.txt')).toContain('+after')
  expect(await saveCheckpoint(h.repo, 'confined snapshot')).toMatch(/^cp-/)
  await expect(readFile(h.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(runtime.exec.mock.calls.some(([file, args]) => file === 'git' && args.includes('add'))).toBe(true)
  const indexes = runtime.exec.mock.calls.flatMap(([, , opts]) => opts?.env?.GIT_INDEX_FILE ?? [])
  expect(indexes.length).toBeGreaterThan(0)
  expect(indexes.every((index) => index === '/tmp/loom-ckpt-fixture123/index')).toBe(true)
  expect(runtime.exec).toHaveBeenCalledWith(
    'rm',
    ['-rf', '--', '/tmp/loom-ckpt-fixture123'],
    expect.objectContaining({ cwd: h.repo })
  )
})

it('preserves raw Git bytes and forwards only the explicitly scoped temporary index environment', async () => {
  const h = await repository()
  const runtime = confinedGit(h.repo)
  Git.setGitRuntimeResolver(() => runtime)
  expect(await Git.gitRaw(h.repo, ['status', '-z'])).toBe(' M payload.txt\0')
  await Git.gitWithEnv(h.repo, ['add', '-A'], { GIT_INDEX_FILE: '/tmp/loom-ckpt-fixture123/index' })
  const options = runtime.exec.mock.calls.at(-1)![2]!
  expect(options.env).toEqual({ GIT_INDEX_FILE: '/tmp/loom-ckpt-fixture123/index' })
  const calls = runtime.exec.mock.calls.length
  await expect(
    Git.gitWithEnv(h.repo, ['fetch'], {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: 'fixture-host-auth'
    })
  ).rejects.toThrow(/environment|credential|host/i)
  expect(runtime.exec).toHaveBeenCalledTimes(calls)
})

it('never retries a stopped or failed container Git command on the host', async () => {
  const h = await repository()
  const runtime = {
    exec: vi.fn<WorkspaceRuntime['exec']>().mockRejectedValue(new Error('Start the workspace first'))
  }
  Git.setGitRuntimeResolver(() => runtime)
  await expect(Git.gitWithEnv(h.repo, ['add', '-A'], {})).rejects.toThrow(/Start the workspace/)
  await expect(readFile(h.marker)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(runtime.exec).toHaveBeenCalledOnce()
})

it('does not trust a runtime-supplied checkpoint cleanup path outside its private temporary directory', async () => {
  const h = await repository()
  const runtime = confinedGit(h.repo)
  const original = runtime.exec.getMockImplementation()!
  runtime.exec.mockImplementation((file, args, opts) =>
    file === 'mktemp' ? Promise.resolve({ stdout: '/\n', stderr: '' }) : original(file, args, opts)
  )
  Git.setGitRuntimeResolver(() => runtime)
  await expect(saveCheckpoint(h.repo, 'reject bad temporary path')).rejects.toThrow(
    /temporary|index|checkpoint/i
  )
  expect(runtime.exec.mock.calls.some(([file]) => file === 'rm')).toBe(false)
  await expect(readFile(h.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('removes a confined temporary index after staging fails without writing or cleaning host paths', async () => {
  const h = await repository()
  const runtime = confinedGit(h.repo)
  const original = runtime.exec.getMockImplementation()!
  runtime.exec.mockImplementation((file, args, opts) =>
    file === 'git' && args.includes('add')
      ? Promise.reject(new Error('Fixture staging failed'))
      : original(file, args, opts)
  )
  Git.setGitRuntimeResolver(() => runtime)
  await expect(saveCheckpoint(h.repo, 'failed staging')).rejects.toThrow(/staging failed/i)
  expect(runtime.exec).toHaveBeenCalledWith(
    'rm',
    ['-rf', '--', '/tmp/loom-ckpt-fixture123'],
    expect.objectContaining({ cwd: h.repo })
  )
  await expect(readFile(h.marker)).rejects.toMatchObject({ code: 'ENOENT' })
})
