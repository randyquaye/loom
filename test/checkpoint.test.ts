import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  CheckpointBusyError,
  diffCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  saveCheckpoint
} from '../src/main/git/checkpoint'
import { ensureContextIgnored } from '../src/main/git/exclude'

const exec = promisify(execFile)

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-ckpt-'))
  const run = (...args: string[]) => exec('git', ['-C', root, ...args])
  await run('init', '-q', '-b', 'main')
  await run('config', 'user.email', 't@example.com')
  await run('config', 'user.name', 't')
  await run('config', 'commit.gpgsign', 'false')
  await writeFile(path.join(root, 'a.txt'), 'one\n')
  await run('add', '.')
  await run('commit', '-q', '-m', 'init')
  await ensureContextIgnored(root)
  return root
}

describe('checkpoints', () => {
  it('saves and lists without touching HEAD or the worktree', async () => {
    const root = await repo()
    const headBefore = (await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
    await writeFile(path.join(root, 'a.txt'), 'two\n')
    await writeFile(path.join(root, 'u.txt'), 'untracked\n')

    const id = await saveCheckpoint(root, 'first save')

    expect((await exec('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore)
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('two\n')
    const list = await listCheckpoints(root)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id, label: 'first save' })
  })

  it('restores tracked and untracked content and drops later untracked files', async () => {
    const root = await repo()
    await writeFile(path.join(root, 'a.txt'), 'two\n')
    await writeFile(path.join(root, 'u.txt'), 'untracked\n')
    const id = await saveCheckpoint(root, 'cp')
    await writeFile(path.join(root, 'a.txt'), 'three\n')
    await writeFile(path.join(root, 'v.txt'), 'later\n')
    await rm(path.join(root, 'u.txt'))

    expect(await diffCheckpoint(root, id)).toContain('-two')

    await restoreCheckpoint(root, id)

    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('two\n')
    expect(await readFile(path.join(root, 'u.txt'), 'utf8')).toBe('untracked\n')
    await expect(readFile(path.join(root, 'v.txt'), 'utf8')).rejects.toThrow()
    expect(await diffCheckpoint(root, id)).toBe('')
  })

  it('keeps ignored .context files out of checkpoints and out of clean', async () => {
    const root = await repo()
    await mkdir(path.join(root, '.context'), { recursive: true })
    await writeFile(path.join(root, '.context', 'loom.context'), 'ctx\n')
    const id = await saveCheckpoint(root, 'with context')
    await rm(path.join(root, '.context', 'loom.context'))

    await restoreCheckpoint(root, id)

    // Ignored paths are neither captured by the checkpoint nor removed by clean -fd.
    await expect(readFile(path.join(root, '.context', 'loom.context'), 'utf8')).rejects.toThrow()
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\n')
  })

  it('refuses to save while a merge is in progress', async () => {
    const root = await repo()
    await writeFile(path.join(root, '.git', 'MERGE_HEAD'), 'deadbeef\n')
    await expect(saveCheckpoint(root, 'nope')).rejects.toBeInstanceOf(CheckpointBusyError)
  })
})
