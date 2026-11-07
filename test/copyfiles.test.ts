import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { copyWorkspaceFiles, globToRegex } from '../src/main/workspace/copyfiles'

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

const execFileAsync = promisify(execFile)

describe('globToRegex', () => {
  it('matches .env* against dotfiles but not bare names', () => {
    const re = globToRegex('.env*')
    expect(re.test('.env')).toBe(true)
    expect(re.test('.env.local')).toBe(true)
    expect(re.test('env')).toBe(false)
    expect(re.test('src/.env')).toBe(false)
  })

  it('treats **/ as zero or more directories', () => {
    const re = globToRegex('docs/**/*.md')
    expect(re.test('docs/a.md')).toBe(true)
    expect(re.test('docs/x/y.md')).toBe(true)
    expect(re.test('docs/x/y/z.md')).toBe(true)
    expect(re.test('other/a.md')).toBe(false)
  })

  it('keeps ? single-character', () => {
    const re = globToRegex('a?c.txt')
    expect(re.test('abc.txt')).toBe(true)
    expect(re.test('ac.txt')).toBe(false)
  })
})

describe('copyWorkspaceFiles', () => {
  it('copies matching seeds into the worktree and never clobbers checkout content', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'loom-copy-'))
    const repo = path.join(root, 'repo')
    const worktree = path.join(root, 'wt')
    const run = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
    await execFileAsync('mkdir', ['-p', repo, `${worktree}/docs`, `${repo}/docs`])
    await run('init', '-q', '-b', 'main')
    await run('config', 'user.email', 't@example.com')
    await run('config', 'user.name', 't')
    await writeFile(path.join(repo, 'README.md'), 'tracked\n')
    await writeFile(path.join(repo, '.env'), 'SECRET=seed\n')
    await writeFile(path.join(repo, '.env.local'), 'SECRET=local\n')
    await writeFile(path.join(repo, 'keep.txt'), 'no match\n')
    await writeFile(path.join(repo, 'docs', 'a.md'), 'doc\n')
    await run('add', 'README.md')
    await run('commit', '-q', '-m', 'init')
    // The checkout already has a docs/a.md that must survive untouched.
    await writeFile(path.join(worktree, 'docs', 'a.md'), 'checkout copy\n')

    const copied = await copyWorkspaceFiles(repo, worktree, ['.env*', 'docs/**/*.md'])

    expect(copied).toBe(2)
    expect(await readFile(path.join(worktree, '.env'), 'utf8')).toBe('SECRET=seed\n')
    expect(await readFile(path.join(worktree, '.env.local'), 'utf8')).toBe('SECRET=local\n')
    expect(await readFile(path.join(worktree, 'docs', 'a.md'), 'utf8')).toBe('checkout copy\n')
  })
})
