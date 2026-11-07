import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { diffFor, listChanges } from '../src/main/git/status'

const exec = promisify(execFile)

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-status-'))
  const run = (...args: string[]) => exec('git', ['-C', root, ...args])
  await run('init', '-q', '-b', 'main')
  await run('config', 'user.email', 't@example.com')
  await run('config', 'user.name', 't')
  // Test repos must commit even when the developer's global config enables SSH signing.
  await run('config', 'commit.gpgsign', 'false')
  await writeFile(path.join(root, 'a.txt'), 'one\n')
  await writeFile(path.join(root, 'b.txt'), 'two\n')
  await run('add', '.')
  await run('commit', '-q', '-m', 'init')
  return root
}

describe('git status and diff', () => {
  it('reports nothing on a clean worktree', async () => {
    const root = await repo()
    expect(await listChanges(root)).toEqual([])
  })

  it('classifies unstaged, staged, deleted and untracked changes', async () => {
    const root = await repo()
    await writeFile(path.join(root, 'a.txt'), 'one changed\n')
    await rm(path.join(root, 'b.txt'))
    await writeFile(path.join(root, 'c.txt'), 'new\n')
    await writeFile(path.join(root, 'd.txt'), 'staged\n')
    await exec('git', ['-C', root, 'add', 'd.txt'])

    const byPath = Object.fromEntries((await listChanges(root)).map((e) => [e.path, e]))

    expect(byPath['a.txt']).toMatchObject({ status: 'modified', staged: false, unstaged: true })
    expect(byPath['b.txt']).toMatchObject({ status: 'deleted', staged: false, unstaged: true })
    expect(byPath['c.txt']).toMatchObject({ status: 'untracked', staged: false, unstaged: false })
    expect(byPath['d.txt']).toMatchObject({ status: 'added', staged: true, unstaged: false })
  })

  it('diffs tracked changes against HEAD', async () => {
    const root = await repo()
    await writeFile(path.join(root, 'a.txt'), 'one changed\n')

    const diff = await diffFor(root, 'a.txt')

    expect(diff).toContain('-one')
    expect(diff).toContain('+one changed')
  })

  it('diffs deletions and synthesises untracked files as all-additions', async () => {
    const root = await repo()
    await rm(path.join(root, 'b.txt'))
    await writeFile(path.join(root, 'c.txt'), 'new\n')

    expect(await diffFor(root, 'b.txt')).toContain('-two')
    const untracked = await diffFor(root, 'c.txt')
    expect(untracked).toContain('--- /dev/null')
    expect(untracked).toContain('+new')
  })
})
