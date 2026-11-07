import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import {
  assertSafeBaseRef,
  BaseRefRejectedError,
  BaseRefUnavailableError,
  resolveBaseRef,
  type GitRunner
} from '../src/main/git/baseref'
import { GIT_HARDENING_ARGS } from '../src/main/git/run'

// The machine's global config signs every commit over ssh; tests must not depend on it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function sh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_HARDENING_ARGS, ...args], { cwd, shell: false })
  return stdout.trim()
}

async function initRepo(name: string): Promise<string> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'loom-baseref-'))
  roots.push(root)
  const dir = path.join(root, name)
  await mkdir(dir, { recursive: true })
  await sh(['init', '-q', '-b', 'main', dir], root)
  await sh(['config', 'user.email', 'loom@test.invalid'], dir)
  await sh(['config', 'user.name', 'Loom Test'], dir)
  await writeFile(path.join(dir, 'README.md'), '# demo\n', 'utf8')
  await sh(['add', 'README.md'], dir)
  await sh(['commit', '-q', '-m', 'init'], dir)
  return dir
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

/** Records argv while still running real git, so "did not fetch" is provable. */
function recording(run: GitRunner): { calls: (readonly string[])[]; wrapped: GitRunner } {
  const calls: (readonly string[])[] = []
  return {
    calls,
    wrapped: async (repoPath, args) => {
      calls.push(args)
      return run(repoPath, args)
    }
  }
}

const realGit: GitRunner = async (repoPath, args) => sh([...args], repoPath)

/** A remote-tracking ref appears only after the fetch, which is what we want to prove. */
const fakeRemoteRunner: GitRunner = async (_repoPath, args) => {
  if (args[0] === 'rev-parse') {
    const ref = args[args.length - 1] ?? ''
    if (ref.startsWith('refs/remotes/origin/')) return 'deadbeef\n'
    throw new Error('GIT_COMMAND_FAILED: fatal: needed a single revision')
  }
  if (args[0] === 'fetch') return ''
  throw new Error(`unexpected invocation: ${args.join(' ')}`)
}

describe('assertSafeBaseRef', () => {
  it('rejects anything that could be read as a flag or rewrite a refspec', () => {
    for (const bad of ['', '   ', '-b', '--all', 'main extra', 'a:b', 'src:dst']) {
      expect(() => assertSafeBaseRef(bad)).toThrow(BaseRefRejectedError)
    }
  })

  it('accepts ordinary branch names, nested names and shas', () => {
    for (const ok of ['main', 'randy/fix-flux', 'v1.2.3', 'deadbeef']) {
      expect(() => assertSafeBaseRef(ok)).not.toThrow()
    }
  })
})

describe('resolveBaseRef against a real repository', () => {
  it('returns a local branch as-is and never fetches', async () => {
    const repo = await initRepo('local-branch')
    const { calls, wrapped } = recording(realGit)

    await expect(resolveBaseRef(repo, 'main', wrapped)).resolves.toBe('main')
    expect(calls.some((args) => args[0] === 'fetch')).toBe(false)
  })

  it('returns a resolvable commit sha as-is', async () => {
    const repo = await initRepo('sha')
    const sha = await sh(['rev-parse', 'HEAD'], repo)

    await expect(resolveBaseRef(repo, sha, realGit)).resolves.toBe(sha)
  })

  it('reports an unavailable ref when there is no origin to fetch from', async () => {
    const repo = await initRepo('no-origin')

    await expect(resolveBaseRef(repo, 'randy/fix-flux', realGit)).rejects.toBeInstanceOf(
      BaseRefUnavailableError
    )
  })

  it('rejects a dangerous ref before touching git', async () => {
    const repo = await initRepo('dangerous')
    const { calls, wrapped } = recording(realGit)

    await expect(resolveBaseRef(repo, '--all', wrapped)).rejects.toBeInstanceOf(BaseRefRejectedError)
    expect(calls).toHaveLength(0)
  })
})

describe('resolveBaseRef fetch path', () => {
  it('fetches a branch that exists only on origin and returns the tracking ref', async () => {
    const calls: (readonly string[])[] = []
    const runner: GitRunner = async (repoPath, args) => {
      calls.push(args)
      return fakeRemoteRunner(repoPath, args)
    }

    const resolved = await resolveBaseRef('/repo', 'randy/fix-flux', runner)

    expect(resolved).toBe('refs/remotes/origin/randy/fix-flux')
    expect(calls).toEqual([
      ['rev-parse', '--verify', '--quiet', 'randy/fix-flux^{commit}'],
      [
        'fetch',
        '--no-tags',
        '--quiet',
        'origin',
        '+refs/heads/randy/fix-flux:refs/remotes/origin/randy/fix-flux'
      ],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/randy/fix-flux^{commit}']
    ])
  })

  it('reports the git detail when the fetch itself fails', async () => {
    const runner: GitRunner = async (_repoPath, args) => {
      if (args[0] === 'fetch') throw new Error("GIT_COMMAND_FAILED: 'origin' does not appear to be a git repository")
      throw new Error('GIT_COMMAND_FAILED: fatal: needed a single revision')
    }

    await expect(resolveBaseRef('/repo', 'randy/fix-flux', runner)).rejects.toThrow(
      /BASE_REF_UNAVAILABLE.*does not appear to be a git repository/
    )
  })

  it('does not trust a fetch that exits 0 without providing the ref', async () => {
    const runner: GitRunner = async (_repoPath, args) => {
      if (args[0] === 'fetch') return ''
      throw new Error('GIT_COMMAND_FAILED: fatal: needed a single revision')
    }

    await expect(resolveBaseRef('/repo', 'ghost/branch', runner)).rejects.toThrow(
      /origin did not provide that branch/
    )
  })
})
