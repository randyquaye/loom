import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { initEmptyRepo } from '../src/main/git/projects'
import { GIT_HARDENING_ARGS } from '../src/main/git/run'
import { addWorktree } from '../src/main/git/worktree'
import { ensureInitialCommit } from '../src/main/workspace/bootstrap'

// The machine's global config signs every commit over ssh; tests must not depend on it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function tempRoot(tag: string): Promise<string> {
  const dir = await mkdtemp(path.join(await realpath(tmpdir()), tag))
  roots.push(dir)
  return dir
}

async function sh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_HARDENING_ARGS, ...args], {
    cwd,
    shell: false
  })
  return stdout.trim()
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('quick start repos', () => {
  it('are born with a commit, so a worktree can be cut from them', async () => {
    const dataRoot = await tempRoot('loom-qs-')
    const project = await initEmptyRepo(dataRoot, 'demo')

    await expect(sh(['rev-parse', '--verify', 'HEAD'], project.repoPath)).resolves.not.toBe('')
    await expect(sh(['log', '--format=%s'], project.repoPath)).resolves.toBe('Loom quick start')

    const worktree = await addWorktree(project.repoPath, dataRoot, 'demo', 'ws-one', null)
    expect(worktree.path).toContain('ws-one')
    expect(worktree.branch).toBe('loom/ws-one')
  })
})

describe('ensureInitialCommit', () => {
  it('gives an unborn repo one commit', async () => {
    const root = await tempRoot('loom-uic-')
    await sh(['init', '-q', '-b', 'main', '.'], root)
    await expect(sh(['rev-parse', '--verify', 'HEAD'], root)).rejects.toThrow()

    await ensureInitialCommit(root)

    await expect(sh(['rev-parse', '--verify', 'HEAD'], root)).resolves.not.toBe('')
    // Nothing to commit is fine: the commit is allowed to be empty.
    await expect(sh(['log', '--format=%s'], root)).resolves.toBe('Loom quick start')
  })

  it('leaves a repo that already has history untouched', async () => {
    const root = await tempRoot('loom-uic-born-')
    await sh(['init', '-q', '-b', 'main', '.'], root)
    await writeFile(path.join(root, 'a.txt'), 'a\n', 'utf8')
    await sh(['add', 'a.txt'], root)
    await sh(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first'], root)
    await sh(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'second'],
      root
    )

    await ensureInitialCommit(root)

    await expect(sh(['rev-list', '--count', 'HEAD'], root)).resolves.toBe('2')
  })
})
