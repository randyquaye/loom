import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { CONTEXT_DIR, WORKSPACES_DIR, WORKTREE_BRANCH_PREFIX } from '../src/shared/brand'
import { ensureContextIgnored } from '../src/main/git/exclude'
import {
  addProjectFromLocalPath,
  assertCloneableUrl,
  NotAGitRepositoryError,
  ProjectPathNotFoundError,
  ProjectUrlRejectedError
} from '../src/main/git/projects'
import { GIT_HARDENING_ARGS, GitError } from '../src/main/git/run'
import {
  addWorktree,
  isValidBranchRef,
  listWorktrees,
  removeWorktree,
  WorktreePathEscapeError,
  worktreePathFor
} from '../src/main/git/worktree'

// The machine's global config signs every commit over ssh; tests must not depend on it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function sh(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_HARDENING_ARGS, ...args], {
    cwd,
    shell: false
  })
  return stdout.trim()
}

async function makeRoot(prefix: string): Promise<string> {
  // realpath so paths match what git reports back (macOS symlinks /tmp and /var).
  const root = await mkdtemp(path.join(await realpath(tmpdir()), prefix))
  roots.push(root)
  return root
}

async function initRepo(root: string, name = 'repo'): Promise<string> {
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

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

function excludeFile(repo: string): string {
  return path.join(repo, '.git', 'info', 'exclude')
}

function contextEntryLines(contents: string): string[] {
  return contents.split('\n').filter((line) => line === `${CONTEXT_DIR}/`)
}

/** Installs a post-checkout hook that would leave a marker file if it ever ran. */
async function installSpyHook(repo: string, marker: string): Promise<void> {
  const hook = path.join(repo, '.git', 'hooks', 'post-checkout')
  await mkdir(path.dirname(hook), { recursive: true })
  await writeFile(hook, `#!/bin/sh\ntouch ${marker}\n`, 'utf8')
  await chmod(hook, 0o755)
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('addWorktree', () => {
  it('creates <dataRoot>/workspaces/<projectSlug>/<slug> on branch loom/<slug>', async () => {
    const root = await makeRoot('loom-git-add-')
    const repo = await initRepo(root)
    const dataRoot = path.join(root, 'data')

    const added = await addWorktree(repo, dataRoot, 'demo-project', 'fix-login')

    expect(added.branch).toBe(`${WORKTREE_BRANCH_PREFIX}fix-login`)
    expect(added.path).toBe(path.join(dataRoot, WORKSPACES_DIR, 'demo-project', 'fix-login'))
    expect(await exists(added.path)).toBe(true)
    expect(await exists(path.join(added.path, 'README.md'))).toBe(true)
  })

  it('reports the new worktree and its branch from listWorktrees', async () => {
    const root = await makeRoot('loom-git-list-')
    const repo = await initRepo(root)
    const added = await addWorktree(repo, path.join(root, 'data'), 'demo-project', 'ws-a')

    const entries = await listWorktrees(repo)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ path: repo, branch: 'main', bare: false })
    expect(entries[1]).toMatchObject({ path: added.path, branch: added.branch, bare: false })
  })

  it('surfaces a git failure as GitError when the branch already exists', async () => {
    const root = await makeRoot('loom-git-dup-')
    const repo = await initRepo(root)
    await addWorktree(repo, path.join(root, 'data'), 'demo-project', 'ws-a')

    await expect(addWorktree(repo, path.join(root, 'data2'), 'demo-project', 'ws-a')).rejects.toBeInstanceOf(
      GitError
    )
  })

  it('does not run a repository-installed post-checkout hook', async () => {
    const root = await makeRoot('loom-git-hooks-')
    const repo = await initRepo(root)
    const marker = path.join(root, 'HOOK_RAN')
    await installSpyHook(repo, marker)

    await addWorktree(repo, path.join(root, 'data'), 'demo-project', 'ws-a')

    expect(await exists(marker)).toBe(false)
  })

  it('refuses a slug that would escape the project workspaces root', async () => {
    const root = await makeRoot('loom-git-escape-')
    const repo = await initRepo(root)
    const dataRoot = path.join(root, 'data')

    expect(() => worktreePathFor(dataRoot, 'demo-project', '../escape')).toThrow(WorktreePathEscapeError)
    await expect(addWorktree(repo, dataRoot, 'demo-project', '..')).rejects.toBeInstanceOf(
      WorktreePathEscapeError
    )
    expect(await exists(path.join(dataRoot, WORKSPACES_DIR, 'escape'))).toBe(false)
    expect(await exists(path.join(root, 'escape'))).toBe(false)
  })
})

describe('isValidBranchRef', () => {
  it('defers to git check-ref-format', async () => {
    const root = await makeRoot('loom-git-ref-')
    const repo = await initRepo(root)

    expect(await isValidBranchRef(repo, 'loom/fix-login')).toBe(true)
    expect(await isValidBranchRef(repo, 'loom/../escape')).toBe(false)
    expect(await isValidBranchRef(repo, 'loom/taken.lock')).toBe(false)
    expect(await isValidBranchRef(repo, 'loom/x~1')).toBe(false)
  })
})

describe('removeWorktree', () => {
  it('deletes the worktree directory and its branch', async () => {
    const root = await makeRoot('loom-git-rm-')
    const repo = await initRepo(root)
    const added = await addWorktree(repo, path.join(root, 'data'), 'demo-project', 'ws-a')

    await removeWorktree(repo, added.path, added.branch)

    expect(await exists(added.path)).toBe(false)
    expect((await listWorktrees(repo)).map((e) => e.branch)).toEqual(['main'])
  })
})

describe('ensureContextIgnored', () => {
  it(`appends ${CONTEXT_DIR}/ exactly once across two calls`, async () => {
    const root = await makeRoot('loom-git-exclude-')
    const repo = await initRepo(root)
    const before = await readFile(excludeFile(repo), 'utf8')

    await ensureContextIgnored(repo)
    await ensureContextIgnored(repo)

    const after = await readFile(excludeFile(repo), 'utf8')
    expect(contextEntryLines(after)).toHaveLength(1)
    expect(after).toBe(`${before}${CONTEXT_DIR}/\n`)
  })

  it('keeps existing exclude entries and leaves a tracked .gitignore alone', async () => {
    const root = await makeRoot('loom-git-gitignore-')
    const repo = await initRepo(root)
    await writeFile(excludeFile(repo), 'node_modules', 'utf8')
    const gitignore = path.join(repo, '.gitignore')
    await writeFile(gitignore, 'dist/\n', 'utf8')
    await sh(['add', '.gitignore'], repo)
    await sh(['commit', '-q', '-m', 'gitignore'], repo)

    await ensureContextIgnored(repo)
    await ensureContextIgnored(repo)

    expect(await readFile(excludeFile(repo), 'utf8')).toBe(`node_modules\n${CONTEXT_DIR}/\n`)
    expect(await readFile(gitignore, 'utf8')).toBe('dist/\n')
    expect(await sh(['status', '--porcelain'], repo)).toBe('')
  })

  it('covers linked worktrees from the common git dir', async () => {
    const root = await makeRoot('loom-git-exclude-wt-')
    const repo = await initRepo(root)
    const added = await addWorktree(repo, path.join(root, 'data'), 'demo-project', 'ws-a')
    await ensureContextIgnored(repo)
    await mkdir(path.join(added.path, CONTEXT_DIR), { recursive: true })
    await writeFile(path.join(added.path, CONTEXT_DIR, 'notes.md'), 'scratch\n', 'utf8')

    expect(await sh(['status', '--porcelain'], added.path)).toBe('')
  })
})

describe('addProjectFromLocalPath', () => {
  it('stores the repository toplevel and reads origin', async () => {
    const root = await makeRoot('loom-git-proj-')
    const repo = await initRepo(root)
    await sh(['remote', 'add', 'origin', 'https://example.invalid/demo.git'], repo)
    const nested = path.join(repo, 'src', 'deep')
    await mkdir(nested, { recursive: true })

    const project = await addProjectFromLocalPath(path.join(root, 'data'), 'Demo Project', nested)

    expect(project.repoPath).toBe(repo)
    expect(project.name).toBe('Demo Project')
    expect(project.remoteUrl).toBe('https://example.invalid/demo.git')
    expect(project.id).not.toBe('')
    expect(await exists(path.join(root, 'data', WORKSPACES_DIR, 'demo-project'))).toBe(true)
  })

  it('resolves a symlinked folder to the real repository root', async () => {
    const root = await makeRoot('loom-git-symlink-')
    const repo = await initRepo(root)
    const link = path.join(root, 'link')
    await symlink(repo, link, 'dir')

    const project = await addProjectFromLocalPath(path.join(root, 'data'), 'Linked', link)

    expect(project.repoPath).toBe(repo)
  })

  it('rejects a folder that is not a git repository and does not initialize one', async () => {
    const root = await makeRoot('loom-git-nonrepo-')
    const plain = path.join(root, 'plain')
    await mkdir(plain, { recursive: true })

    await expect(addProjectFromLocalPath(path.join(root, 'data'), 'Plain', plain)).rejects.toBeInstanceOf(
      NotAGitRepositoryError
    )
    expect(await exists(path.join(plain, '.git'))).toBe(false)
  })

  it('rejects a path that does not exist or is not a directory', async () => {
    const root = await makeRoot('loom-git-missing-')
    const file = path.join(root, 'file.txt')
    await writeFile(file, 'not a directory\n', 'utf8')

    await expect(addProjectFromLocalPath(root, 'Missing', path.join(root, 'nope'))).rejects.toBeInstanceOf(
      ProjectPathNotFoundError
    )
    await expect(addProjectFromLocalPath(root, 'File', file)).rejects.toBeInstanceOf(ProjectPathNotFoundError)
  })
})

describe('assertCloneableUrl', () => {
  it('accepts https, ssh and scp-style remotes', () => {
    for (const url of [
      'https://github.com/acme/repo.git',
      'ssh://git@github.com/acme/repo.git',
      'git@github.com:acme/repo.git'
    ]) {
      expect(() => assertCloneableUrl(url)).not.toThrow()
    }
  })

  it('rejects command transports, local paths and option-like URLs', () => {
    for (const url of [
      'ext::sh -c touch% /tmp/pwned',
      'fd::3',
      'file:///tmp/local-repo',
      '/tmp/local-repo',
      './relative-repo',
      'git://github.com/acme/repo.git',
      'http://github.com/acme/repo.git',
      '--upload-pack=touch /tmp/pwned'
    ]) {
      expect(() => assertCloneableUrl(url)).toThrow(ProjectUrlRejectedError)
    }
  })
})

describe('removeWorktree orphans', () => {
  it('removes a leftover directory git never registered, and tolerates a missing branch', async () => {
    const root = await makeRoot('loom-wt-orphan-')
    const repo = await initRepo(root)
    const orphan = path.join(root, 'workspaces', 'orphan')
    await mkdir(orphan, { recursive: true })
    await writeFile(path.join(orphan, 'stray.txt'), 'litter\n', 'utf8')

    await removeWorktree(repo, orphan, `${WORKTREE_BRANCH_PREFIX}orphan`)

    expect(await exists(orphan)).toBe(false)
  })

  it('refuses an unregistered directory that grew a .git of its own', async () => {
    const root = await makeRoot('loom-wt-orphan-git-')
    const repo = await initRepo(root)
    const orphan = path.join(root, 'workspaces', 'repo-ish')
    await mkdir(path.join(orphan, '.git'), { recursive: true })

    await expect(removeWorktree(repo, orphan, `${WORKTREE_BRANCH_PREFIX}repo-ish`)).rejects.toThrow(
      /refusing to delete unregistered worktree dir/
    )
    expect(await exists(orphan)).toBe(true)
  })
})
