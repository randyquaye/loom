import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type Database from 'better-sqlite3'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONTEXT_DIR, WORKSPACES_DIR } from '../src/shared/brand'
import type { ProjectRow, WorkspaceRow } from '../src/shared/ipc-contract'
import { MAX_WORKSPACES_PER_PROJECT } from '../src/shared/limits'
import { openDb } from '../src/main/db'
import { insertProject } from '../src/main/db/repos/projects'
import { getWorkspace, listWorkspaces } from '../src/main/db/repos/workspaces'
import { setEnvSecretStore } from '../src/main/env/vars'
import { ensureContextIgnored } from '../src/main/git/exclude'
import { GIT_HARDENING_ARGS } from '../src/main/git/run'
import { listWorktrees } from '../src/main/git/worktree'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import {
  createWorkspace,
  removeWorkspace,
  WorkspaceLimitError,
  WorkspaceNameTakenError
} from '../src/main/workspace/bootstrap'
import { WorkspaceNameError } from '../src/main/workspace/name'

// The machine's global config signs every commit over ssh; tests must not depend on it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'

const execFileAsync = promisify(execFile)

// workspaceEnv reads the env-var overlay from the secret store; tests wire a throwaway one.
beforeEach(() => {
  setEnvSecretStore(
    createSecretStore(
      path.join(mkdtempSync(path.join(tmpdir(), 'loom-env-wb-')), 'secrets.enc'),
      aesGcmCipher(randomBytes(32))
    )
  )
})
const PROJECT_NAME = 'Demo Project'
const PROJECT_SLUG = 'demo-project'

const roots: string[] = []
const databases: Database.Database[] = []

interface Fixture {
  repo: string
  dataRoot: string
  db: Database.Database
  projectId: string
}

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

async function setup(): Promise<Fixture> {
  const root = await makeRoot('loom-ws-')
  const repo = path.join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await sh(['init', '-q', '-b', 'main', repo], root)
  await sh(['config', 'user.email', 'loom@test.invalid'], repo)
  await sh(['config', 'user.name', 'Loom Test'], repo)
  await writeFile(path.join(repo, 'README.md'), '# demo\n', 'utf8')
  await sh(['add', 'README.md'], repo)
  await sh(['commit', '-q', '-m', 'init'], repo)

  const dataRoot = path.join(root, 'data')
  await mkdir(dataRoot, { recursive: true })
  const db = openDb(':memory:')
  databases.push(db)
  return { repo, dataRoot, db, projectId: insertDemoProject(db, PROJECT_NAME, repo) }
}

function insertDemoProject(db: Database.Database, name: string, repoPath: string): string {
  const project: ProjectRow = {
    id: randomUUID(),
    name,
    repoPath,
    remoteUrl: null,
    createdAt: Date.now(),
    customPromptGeneral: null,
    customPromptCodeReview: null,
    customPromptFixErrors: null
  }
  insertProject(db, project)
  return project.id
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function branches(repo: string): Promise<string[]> {
  const out = await sh(['branch', '--format=%(refname:short)'], repo)
  // Sorted so assertions do not depend on git's own ref ordering.
  return out
    .split('\n')
    .filter((branch) => branch !== '')
    .sort()
}

/** Bootstrap is async: rows return as `initializing` and settle to ready/error. */
async function waitForSettled(fx: Fixture, id: string): Promise<WorkspaceRow> {
  const deadline = Date.now() + 8000
  for (;;) {
    const row = getWorkspace(fx.db, id)
    if (row !== null && (row.state === 'ready' || row.state === 'error')) return row
    if (Date.now() > deadline) throw new Error(`workspace ${id} never settled`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function add(fx: Fixture, name: string, projectId = fx.projectId): Promise<WorkspaceRow> {
  const created = await createWorkspace({ db: fx.db, dataRoot: fx.dataRoot, projectId, name })
  return waitForSettled(fx, created.id)
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close()
})

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('createWorkspace', () => {
  it('adds the worktree, seeds .context/README.md and stores the row', async () => {
    const fx = await setup()

    const created = await createWorkspace({
      db: fx.db,
      dataRoot: fx.dataRoot,
      projectId: fx.projectId,
      name: 'fix-login-bug'
    })
    expect(created.state).toBe('initializing')
    expect(created.port).toBe(4100)
    const workspace = await waitForSettled(fx, created.id)
    expect(workspace.state).toBe('ready')

    const expectedPath = path.join(fx.dataRoot, WORKSPACES_DIR, PROJECT_SLUG, 'fix-login-bug')
    expect(workspace).toMatchObject({
      projectId: fx.projectId,
      name: 'fix-login-bug',
      branch: 'loom/fix-login-bug',
      worktreePath: expectedPath,
      archived: false
    })
    expect(await exists(path.join(expectedPath, 'README.md'))).toBe(true)

    const readme = await readFile(path.join(expectedPath, CONTEXT_DIR, 'README.md'), 'utf8')
    expect(readme).toContain(CONTEXT_DIR)
    expect(getWorkspace(fx.db, workspace.id)).toEqual(workspace)
    expect((await listWorktrees(fx.repo)).map((w) => w.branch)).toContain('loom/fix-login-bug')
  })

  it('writes .context/ to info/exclude exactly once across two calls', async () => {
    const fx = await setup()

    await add(fx, 'first')
    await add(fx, 'second')
    await ensureContextIgnored(fx.repo)

    const contents = await readFile(path.join(fx.repo, '.git', 'info', 'exclude'), 'utf8')
    expect(contents.split('\n').filter((line) => line === `${CONTEXT_DIR}/`)).toHaveLength(1)
    expect(await sh(['status', '--porcelain'], fx.repo)).toBe('')
  })

  it(`throws WorkspaceLimitError on the ${MAX_WORKSPACES_PER_PROJECT + 1}th workspace`, async () => {
    const fx = await setup()
    for (let n = 1; n <= MAX_WORKSPACES_PER_PROJECT; n += 1) await add(fx, `ws-${n}`)

    const failure = add(fx, 'ws-6')

    await expect(failure).rejects.toBeInstanceOf(WorkspaceLimitError)
    await expect(failure).rejects.toMatchObject({ code: 'WORKSPACE_LIMIT' })
    expect(listWorkspaces(fx.db, fx.projectId)).toHaveLength(MAX_WORKSPACES_PER_PROJECT)
    expect(await branches(fx.repo)).toHaveLength(MAX_WORKSPACES_PER_PROJECT + 1)
  })

  it('rejects an invalid name before touching the filesystem', async () => {
    const fx = await setup()

    for (const bad of ['../escape', '-leading-dash', 'Fix Login', 'a'.repeat(42), '']) {
      await expect(add(fx, bad)).rejects.toBeInstanceOf(WorkspaceNameError)
    }

    expect(listWorkspaces(fx.db, fx.projectId)).toEqual([])
    expect(await branches(fx.repo)).toEqual(['main'])
    expect(await exists(path.join(fx.dataRoot, WORKSPACES_DIR))).toBe(false)
  })

  it('rejects a duplicate name and leaves no orphan worktree behind', async () => {
    const fx = await setup()
    await add(fx, 'alpha')

    await expect(add(fx, 'alpha')).rejects.toBeInstanceOf(WorkspaceNameTakenError)
    await expect(add(fx, 'alpha')).rejects.toMatchObject({ code: 'WORKSPACE_NAME_TAKEN' })

    expect(listWorkspaces(fx.db, fx.projectId)).toHaveLength(1)
    expect(await branches(fx.repo)).toEqual(['loom/alpha', 'main'])
  })

  it('allocates a distinct branch when another project row shares the repository', async () => {
    const fx = await setup()
    const first = await add(fx, 'beta')
    const otherProjectId = insertDemoProject(fx.db, 'Same Repo', fx.repo)

    const second = await add(fx, 'beta', otherProjectId)

    expect(first.branch).toBe('loom/beta')
    expect(second.branch).toBe('loom/beta-2')
    expect(await exists(second.worktreePath)).toBe(true)
  })

  it('allocates distinct ten-port blocks per workspace', async () => {
    const fx = await setup()
    const first = await add(fx, 'one')
    const second = await add(fx, 'two')

    expect(first.port).toBe(4100)
    expect(second.port).toBe(4110)
  })

  it('copies .env seeds and runs the setup script from .loom/settings.toml', async () => {
    const fx = await setup()
    await writeFile(path.join(fx.repo, '.env'), 'SECRET=seed\n', 'utf8')
    await mkdir(path.join(fx.repo, '.loom'), { recursive: true })
    await writeFile(
      path.join(fx.repo, '.loom', 'settings.toml'),
      '[scripts]\nsetup = "touch setup-ran.txt"\n',
      'utf8'
    )
    await sh(['add', '.loom'], fx.repo)
    await sh(['commit', '-q', '-m', 'settings'], fx.repo)

    const workspace = await add(fx, 'seeded')

    expect(workspace.state).toBe('ready')
    expect(await exists(path.join(workspace.worktreePath, '.env'))).toBe(true)
    expect(await exists(path.join(workspace.worktreePath, 'setup-ran.txt'))).toBe(true)
    expect(workspace.initializationFilesCopied).toBeGreaterThanOrEqual(1)
    expect(workspace.setupLogPath).not.toBeNull()
  })

  it('marks the workspace errored when the setup script fails', async () => {
    const fx = await setup()
    await mkdir(path.join(fx.repo, '.loom'), { recursive: true })
    await writeFile(path.join(fx.repo, '.loom', 'settings.toml'), '[scripts]\nsetup = "exit 3"\n', 'utf8')
    await sh(['add', '.loom'], fx.repo)
    await sh(['commit', '-q', '-m', 'settings'], fx.repo)

    const workspace = await add(fx, 'broken-setup')

    expect(workspace.state).toBe('error')
    const log = await readFile(workspace.setupLogPath as string, 'utf8').catch(() => '')
    expect(typeof log).toBe('string')
  })

  it('recovers a stale branch and husk dir left by a dead bootstrap', async () => {
    const fx = await setup()
    await sh(['branch', 'loom/ghost'], fx.repo)
    const husk = path.join(fx.dataRoot, WORKSPACES_DIR, PROJECT_SLUG, 'ghost')
    await mkdir(path.join(husk, CONTEXT_DIR), { recursive: true })
    await writeFile(path.join(husk, CONTEXT_DIR, 'README.md'), 'leftover\n', 'utf8')

    const workspace = await add(fx, 'ghost')

    expect(workspace.state).toBe('ready')
    expect((await listWorktrees(fx.repo)).map((w) => w.branch)).toContain('loom/ghost')
    const readme = await readFile(path.join(husk, CONTEXT_DIR, 'README.md'), 'utf8')
    expect(readme).toContain(CONTEXT_DIR)
  })

  it('keeps the init log under the data root and points a pre-setup failure at it', async () => {
    const fx = await setup()
    const created = await createWorkspace({
      db: fx.db,
      dataRoot: fx.dataRoot,
      projectId: fx.projectId,
      name: 'bad-base',
      baseRef: 'no-such-ref-anywhere'
    })
    const workspace = await waitForSettled(fx, created.id)

    expect(workspace.state).toBe('error')
    expect(workspace.setupLogPath?.startsWith(path.join(fx.dataRoot, 'logs'))).toBe(true)
    const log = await readFile(workspace.setupLogPath as string, 'utf8')
    expect(log).toContain('error:')
  })
})

describe('removeWorkspace', () => {
  it('cleans the worktree directory, the branch and the db row', async () => {
    const fx = await setup()
    const workspace = await add(fx, 'doomed')
    expect(await exists(workspace.worktreePath)).toBe(true)

    await removeWorkspace({ db: fx.db, repoPath: fx.repo, workspace })

    expect(await exists(workspace.worktreePath)).toBe(false)
    expect(await branches(fx.repo)).toEqual(['main'])
    expect((await listWorktrees(fx.repo)).map((w) => w.path)).toEqual([fx.repo])
    expect(getWorkspace(fx.db, workspace.id)).toBeNull()
    expect(listWorkspaces(fx.db, fx.projectId)).toEqual([])
  })

  it('removes a row whose worktree is a husk dir plus a stale branch', async () => {
    const fx = await setup()
    await sh(['branch', 'loom/husk'], fx.repo)
    const husk = path.join(fx.dataRoot, WORKSPACES_DIR, PROJECT_SLUG, 'husk')
    await mkdir(path.join(husk, CONTEXT_DIR), { recursive: true })
    const row: WorkspaceRow = {
      id: randomUUID(),
      projectId: fx.projectId,
      name: 'husk',
      branch: 'loom/husk',
      worktreePath: husk,
      createdAt: Date.now(),
      archived: false,
      state: 'error',
      port: 4100,
      initializationFilesCopied: null,
      setupLogPath: null,
      checkout: 'worktree',
      runtime: 'machine',
      ownerId: null
    }
    fx.db
      .prepare(
        `INSERT INTO workspaces
         (id, project_id, name, branch, worktree_path, created_at, archived, state, port)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.projectId, row.name, row.branch, row.worktreePath, row.createdAt, 0, row.state, row.port)

    await removeWorkspace({ db: fx.db, repoPath: fx.repo, workspace: row })

    expect(await exists(husk)).toBe(false)
    expect(await branches(fx.repo)).toEqual(['main'])
    expect(getWorkspace(fx.db, row.id)).toBeNull()
  })

  it('frees the slug so the same name can be reused', async () => {
    const fx = await setup()
    const workspace = await add(fx, 'reusable')
    await removeWorkspace({ db: fx.db, repoPath: fx.repo, workspace })

    const recreated = await add(fx, 'reusable')

    expect(recreated.branch).toBe('loom/reusable')
    expect(await exists(recreated.worktreePath)).toBe(true)
  })
})
