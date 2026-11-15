import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { insertProject } from '../src/main/db/repos/projects'
import { ensureUser } from '../src/main/db/repos/users'
import { getWorkspaceOrThrow, insertWorkspace } from '../src/main/db/repos/workspaces'
import { createBotService } from '../src/main/bots/repository'
import { createOrgService } from '../src/main/org/service'
import { createRunnerAdmission } from '../src/main/runner/admission'
import { setEnvSecretStore, setEnvVar } from '../src/main/env/vars'
import { aesGcmCipher, createSecretStore } from '../src/main/secrets'
import { writeInstructions } from '../src/main/instructions/files'
import { robotConfig, type BotInvocation } from '../src/shared/bots'
import type { ProjectRow, WorkspaceRow } from '../src/shared/ipc-contract'
import type { CreateWorkspaceInput } from '../src/main/workspace/bootstrap'
import type { sendTurn } from '../src/main/sessions/service'

const run = promisify(execFile)
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-bot-execution-'))
  const db = openDb(':memory:')
  const org = createOrgService(db, { ownerEmail: 'owner@example.com', publicUrl: 'https://loom.example.com' })
  ensureUser(db, { id: 'owner', email: 'owner@example.com' })
  org.admitGoogle('owner', 'owner@example.com', '')
  const bots = createBotService({ db, org })
  const bot = bots.create('owner', 'robot', {
    ...robotConfig(),
    instructions: 'Original Robot instructions',
    repositories: ['example/project'],
    skills: [{ name: 'investigation', instructions: 'Collect evidence before conclusions.' }]
  })
  const project: ProjectRow = {
    id: 'p1',
    name: 'project',
    repoPath: root,
    remoteUrl: 'https://github.com/example/project.git',
    createdAt: 1,
    customPromptGeneral: null,
    customPromptCodeReview: null,
    customPromptFixErrors: null
  }
  insertProject(db, project)
  setEnvSecretStore(createSecretStore(path.join(root, 'secrets.enc'), aesGcmCipher(randomBytes(32))))
  const admission = createRunnerAdmission({
    db,
    isAdmitted: (id) => org.active(id),
    maxRunning: 10,
    minFreeBytes: 0,
    available: async () => Number.MAX_SAFE_INTEGER
  })
  const invocation: BotInvocation = {
    id: randomUUID(),
    botId: bot.id,
    requesterId: 'owner',
    requestKey: 'request-1',
    fingerprint: 'fixture',
    configRevision: bot.revision,
    config: structuredClone(bot.config),
    repository: 'example/project',
    prompt: 'Investigate the selected repository',
    workspaceId: randomUUID(),
    sessionId: randomUUID(),
    messageId: randomUUID(),
    state: 'preparing',
    error: null,
    createdAt: 1,
    updatedAt: 1
  }
  const worktreePath = path.join(root, 'workspace')
  const sent = vi.fn<typeof sendTurn>().mockResolvedValue(undefined)
  const credentialsReady = vi.fn().mockResolvedValue(undefined)
  let allowed = true
  let beforePrepare: ((workspace: WorkspaceRow) => Promise<void>) | undefined
  const assertCurrent = () => {
    if (!allowed) throw new Error('Controller grant was revoked')
  }
  const create = vi.fn(async (input: CreateWorkspaceInput) => {
    await mkdir(worktreePath, { recursive: true })
    const workspace: WorkspaceRow = {
      id: input.id!,
      projectId: input.projectId,
      name: input.name,
      branch: 'loom/robot-fixture',
      worktreePath,
      createdAt: 1,
      archived: false,
      state: 'ready',
      port: 4100,
      initializationFilesCopied: null,
      setupLogPath: null,
      checkout: input.checkout!,
      runtime: input.runtime!,
      ownerId: input.ownerId!
    }
    insertWorkspace(db, workspace, input.modes)
    await beforePrepare?.(workspace)
    await input.prepareWorkspace?.(workspace)
    return workspace
  })
  const settle = vi.fn(async (_db, workspaceId: string) => getWorkspaceOrThrow(db, workspaceId))
  cleanup.push(async () => {
    await admission.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    db,
    org,
    bots,
    bot,
    project,
    invocation,
    worktreePath,
    sent,
    create,
    settle,
    credentialsReady,
    assertCurrent,
    beforePrepare: (prepare: (workspace: WorkspaceRow) => Promise<void>) => {
      beforePrepare = prepare
    },
    revoke: () => {
      allowed = false
    },
    options: {
      db,
      dataRoot: root,
      admission,
      projectFor: async () => project,
      credentialsReady,
      operations: { createWorkspace: create, waitForWorkspaceSettled: settle, sendTurn: sent }
    }
  }
}

it('executes reserved bot-owned identities using the original instructions and actual skill contents', async () => {
  const h = await fixture()
  await writeInstructions(h.root, 'instance', null, 'PRIVATE HUMAN INSTRUCTIONS')
  h.bots.update('owner', h.bot.id, { ...h.bot.config, instructions: 'Later bot configuration' }, true, 1)
  const { createBotExecution } = await import('../src/main/bots/execution')
  await createBotExecution(h.options).provision(h.invocation, h.assertCurrent)
  expect(h.credentialsReady).toHaveBeenCalledWith(h.bot.id, h.invocation.config, h.invocation.workspaceId)
  expect(h.credentialsReady.mock.invocationCallOrder[0]).toBeLessThan(h.create.mock.invocationCallOrder[0]!)
  const workspace = getWorkspaceOrThrow(h.db, h.invocation.workspaceId)
  expect(workspace).toMatchObject({ ownerId: h.bot.id, runtime: 'container', checkout: 'clone' })
  const stored = h.db
    .prepare('SELECT id,workspace_id,instruction_snapshot,backend,model,effort FROM sessions WHERE id=?')
    .get(h.invocation.sessionId) as { instruction_snapshot: string }
  expect(stored).toMatchObject({
    workspace_id: h.invocation.workspaceId,
    backend: h.invocation.config.backend
  })
  expect(stored.instruction_snapshot).toContain('Original Robot instructions')
  expect(stored.instruction_snapshot).toContain('Collect evidence before conclusions.')
  expect(stored.instruction_snapshot).not.toContain('PRIVATE HUMAN INSTRUCTIONS')
  expect(stored.instruction_snapshot).not.toContain('Later bot configuration')
  const skill = path.join(h.worktreePath, '.context', 'loombot', '1', 'skills', 'investigation', 'SKILL.md')
  expect(await readFile(skill, 'utf8')).toContain('Collect evidence before conclusions.')
  expect(h.credentialsReady).toHaveBeenCalledWith(h.bot.id, h.invocation.config, h.invocation.workspaceId)
  expect(h.sent).toHaveBeenCalledExactlyOnceWith(
    h.db,
    h.invocation.sessionId,
    h.invocation.prompt,
    [],
    [],
    h.invocation.messageId,
    'owner'
  )
})

it('rechecks current grants after credential preparation and never allocates work after revocation', async () => {
  const h = await fixture()
  h.credentialsReady.mockImplementation(async () => {
    h.revoke()
  })
  const { createBotExecution } = await import('../src/main/bots/execution')
  await expect(createBotExecution(h.options).provision(h.invocation, h.assertCurrent)).rejects.toThrow(
    /revoked/
  )
  expect(h.db.prepare('SELECT id FROM workspaces').all()).toEqual([])
  expect(h.sent).not.toHaveBeenCalled()
})

it('rechecks current grants after setup before accepting a provider turn', async () => {
  const h = await fixture()
  h.settle.mockImplementation(async () => {
    h.revoke()
    return getWorkspaceOrThrow(h.db, h.invocation.workspaceId)
  })
  const { createBotExecution } = await import('../src/main/bots/execution')
  await expect(createBotExecution(h.options).provision(h.invocation, h.assertCurrent)).rejects.toThrow(
    /revoked/
  )
  expect(h.db.prepare('SELECT id FROM sessions').all()).toEqual([])
  expect(h.sent).not.toHaveBeenCalled()
})

it('keeps setup failures visible without dispatching or allocating a replacement workspace', async () => {
  const h = await fixture()
  h.settle.mockImplementation(async () => {
    h.db.prepare("UPDATE workspaces SET state='error' WHERE id=?").run(h.invocation.workspaceId)
    return getWorkspaceOrThrow(h.db, h.invocation.workspaceId)
  })
  const { createBotExecution } = await import('../src/main/bots/execution')
  await expect(createBotExecution(h.options).provision(h.invocation, h.assertCurrent)).rejects.toThrow(
    /setup|ready/i
  )
  expect(h.db.prepare('SELECT id,state FROM workspaces').all()).toEqual([
    { id: h.invocation.workspaceId, state: 'error' }
  ])
  expect(h.sent).not.toHaveBeenCalled()
})

it('refuses skill materialization through a workspace symlink without touching its target', async () => {
  const h = await fixture()
  const outside = path.join(h.root, 'outside')
  await mkdir(outside)
  h.beforePrepare(async () => {
    await mkdir(path.join(h.worktreePath, '.context'), { recursive: true })
    await symlink(outside, path.join(h.worktreePath, '.context', 'loombot'))
  })
  const { createBotExecution } = await import('../src/main/bots/execution')
  await expect(createBotExecution(h.options).provision(h.invocation, h.assertCurrent)).rejects.toThrow(
    /symlink|escapes/i
  )
  expect(await readdir(outside)).toEqual([])
  expect(h.sent).not.toHaveBeenCalled()
})

it('rejects a skill leaf symlink even when its target is another file inside the workspace', async () => {
  const h = await fixture()
  const target = path.join(h.worktreePath, 'repository-instructions.md')
  h.beforePrepare(async () => {
    const directory = path.join(h.worktreePath, '.context', 'loombot', '1', 'skills', 'investigation')
    await mkdir(directory, { recursive: true })
    await writeFile(target, h.invocation.config.skills[0]!.instructions)
    await symlink(target, path.join(directory, 'SKILL.md'))
  })
  const { createBotExecution } = await import('../src/main/bots/execution')
  await expect(createBotExecution(h.options).provision(h.invocation, h.assertCurrent)).rejects.toThrow(
    /symlink/i
  )
  expect(await readFile(target, 'utf8')).toBe(h.invocation.config.skills[0]!.instructions)
  expect(h.sent).not.toHaveBeenCalled()
})

it('never replays a previously provisioned initial prompt or claims someone else’s workspace', async () => {
  const h = await fixture()
  const { createBotExecution } = await import('../src/main/bots/execution')
  const execution = createBotExecution(h.options)
  await execution.provision(h.invocation, h.assertCurrent)
  await expect(execution.provision(h.invocation, h.assertCurrent)).rejects.toThrow(
    /already|inspect|conversation/i
  )
  expect(h.sent).toHaveBeenCalledTimes(1)
  expect(h.db.prepare('SELECT id FROM workspaces').all()).toEqual([{ id: h.invocation.workspaceId }])
  const another = { ...h.invocation, sessionId: randomUUID(), messageId: randomUUID() }
  h.db.prepare("UPDATE workspaces SET owner_id='owner' WHERE id=?").run(h.invocation.workspaceId)
  await expect(execution.provision(another, h.assertCurrent)).rejects.toThrow(/owner|belong|identity/i)
  expect(h.sent).toHaveBeenCalledTimes(1)
})

it('omits raw bot environment values and sets independent Git identity while preserving human overlays', async () => {
  const h = await fixture()
  await h.create({
    db: h.db,
    dataRoot: h.root,
    projectId: 'p1',
    name: 'bot',
    id: h.invocation.workspaceId,
    checkout: 'clone',
    runtime: 'container',
    ownerId: h.bot.id
  })
  const human = {
    ...getWorkspaceOrThrow(h.db, h.invocation.workspaceId),
    id: 'human-workspace',
    ownerId: 'owner',
    name: 'human',
    branch: 'loom/human',
    runtime: 'machine' as const
  }
  insertWorkspace(h.db, human)
  await setEnvVar('global', null, 'BOT_SECRET', 'do-not-inject', h.bot.id)
  await setEnvVar('global', null, 'PERSONAL_VALUE', 'human-value', 'owner')
  const { workspaceEnv } = await import('../src/main/workspace/bootstrap')
  const botEnv = await workspaceEnv(h.db, h.invocation.workspaceId)
  const humanEnv = await workspaceEnv(h.db, human.id)
  expect(botEnv).not.toHaveProperty('BOT_SECRET')
  expect(botEnv).not.toHaveProperty('PERSONAL_VALUE')
  expect(botEnv).toMatchObject({
    GIT_AUTHOR_NAME: 'Robot',
    GIT_AUTHOR_EMAIL: `bot-${h.bot.id}@loom.invalid`,
    GIT_COMMITTER_NAME: 'Robot',
    GIT_COMMITTER_EMAIL: `bot-${h.bot.id}@loom.invalid`
  })
  expect(humanEnv.PERSONAL_VALUE).toBe('human-value')
  expect(humanEnv).not.toHaveProperty('GIT_AUTHOR_EMAIL')
})

it('uses the reserved workspace identity before real asynchronous checkout setup begins', async () => {
  const h = await fixture()
  const repo = path.join(h.root, 'repo')
  await mkdir(repo)
  await run('git', ['init', '-q', '-b', 'main', repo])
  await run('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@loom.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'fixture'
  ])
  h.db.prepare('UPDATE projects SET repo_path=?,remote_url=NULL WHERE id=?').run(repo, 'p1')
  const { createWorkspace, waitForWorkspaceSettled } = await import('../src/main/workspace/bootstrap')
  const created = await createWorkspace({
    db: h.db,
    dataRoot: h.root,
    projectId: 'p1',
    name: 'reserved-workspace',
    id: h.invocation.workspaceId,
    ownerId: h.bot.id
  })
  const settled = await waitForWorkspaceSettled(h.db, created.id)
  expect(created.id).toBe(h.invocation.workspaceId)
  expect(settled.state).toBe('ready')
  expect(h.db.prepare('SELECT owner_id FROM workspaces WHERE id=?').get(h.invocation.workspaceId)).toEqual({
    owner_id: h.bot.id
  })
})

it('rechecks the controller inside workspace insertion after asynchronous git validation', async () => {
  const h = await fixture()
  const worktrees = await import('../src/main/git/worktree')
  const { createWorkspace, waitForWorkspaceSettled } = await import('../src/main/workspace/bootstrap')
  let entered!: () => void
  let release!: () => void
  const checking = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const validation = vi.spyOn(worktrees, 'isValidBranchRef').mockImplementation(async () => {
    entered()
    await held
    return true
  })
  const creating = createWorkspace({
    db: h.db,
    dataRoot: h.root,
    projectId: 'p1',
    name: 'grant-race',
    id: h.invocation.workspaceId,
    ownerId: h.bot.id,
    beforeInsert: h.assertCurrent
  }).then(
    (row) => ({ row, error: null }),
    (error: unknown) => ({ row: null, error })
  )
  try {
    await checking
    h.revoke()
    release()
    const result = await creating
    if (result.row !== null) await waitForWorkspaceSettled(h.db, result.row.id)
    expect(result.error).toEqual(expect.objectContaining({ message: expect.stringContaining('revoked') }))
    expect(h.db.prepare('SELECT id FROM workspaces').all()).toEqual([])
  } finally {
    release()
    await creating
    validation.mockRestore()
  }
})

it('prepares skill and context snapshots before any repository runtime can swap their directory', async () => {
  const h = await fixture()
  const repo = path.join(h.root, 'repo')
  const outside = path.join(h.root, 'outside-runtime-target')
  await mkdir(repo)
  await mkdir(outside)
  await run('git', ['init', '-q', '-b', 'main', repo])
  await run('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@loom.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'fixture'
  ])
  h.db.prepare('UPDATE projects SET repo_path=? WHERE id=?').run(repo, 'p1')
  const runtimes = await import('../src/main/runtime')
  let started = false
  const runtime = vi.spyOn(runtimes, 'runtimeFor').mockImplementation((workspace) => ({
    ensureRunning: async () => {
      const context = await readFile(path.join(workspace.worktreePath, '.context', 'loom.context'), 'utf8')
      expect(context).toContain(
        `session agent: ${h.invocation.config.backend} / ${h.invocation.config.model}`
      )
      expect(context).not.toContain('Environment variables')
      const bundle = path.join(workspace.worktreePath, '.context', 'loombot')
      expect(await readFile(path.join(bundle, '1', 'skills', 'investigation', 'SKILL.md'), 'utf8')).toBe(
        'Collect evidence before conclusions.'
      )
      started = true
      await rm(bundle, { recursive: true, force: true })
      await symlink(outside, bundle)
    },
    exec: async () => ({ stdout: '', stderr: '' }),
    spawn: () => {
      throw new Error('No external provider process in this fixture')
    },
    openTerminal: () => {
      throw new Error('No terminal in this fixture')
    },
    runningCommand: async () => false,
    stop: async () => {}
  }))
  try {
    const { createBotExecution } = await import('../src/main/bots/execution')
    await createBotExecution({ ...h.options, operations: { sendTurn: h.sent } }).provision(
      h.invocation,
      h.assertCurrent
    )
    expect(started).toBe(true)
    expect(await readdir(outside)).toEqual([])
    expect(h.sent).toHaveBeenCalledOnce()
  } finally {
    runtime.mockRestore()
  }
})

it('does not execute repository setup after authority is revoked during runtime or environment startup', async () => {
  const h = await fixture()
  const repo = path.join(h.root, 'repo')
  await mkdir(path.join(repo, '.loom'), { recursive: true })
  await writeFile(path.join(repo, '.loom', 'settings.toml'), '[scripts]\nsetup = "fixture setup"\n')
  await run('git', ['init', '-q', '-b', 'main', repo])
  await run('git', ['-C', repo, 'add', '.loom/settings.toml'])
  await run('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@loom.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture'
  ])
  h.db.prepare('UPDATE projects SET repo_path=? WHERE id=?').run(repo, 'p1')
  const runtimes = await import('../src/main/runtime')
  const execute = vi.fn(async () => ({ stdout: '', stderr: '' }))
  const runtime = vi.spyOn(runtimes, 'runtimeFor').mockImplementation(() => ({
    ensureRunning: async () => {
      h.revoke()
    },
    exec: execute,
    spawn: () => {
      throw new Error('No external process in this fixture')
    },
    openTerminal: () => {
      throw new Error('No terminal in this fixture')
    },
    runningCommand: async () => false,
    stop: async () => {}
  }))
  try {
    const { createWorkspace, waitForWorkspaceSettled } = await import('../src/main/workspace/bootstrap')
    const created = await createWorkspace({
      db: h.db,
      dataRoot: h.root,
      projectId: 'p1',
      id: h.invocation.workspaceId,
      name: 'revoke-during-setup',
      checkout: 'clone',
      runtime: 'container',
      ownerId: h.bot.id,
      beforeInsert: h.assertCurrent
    })
    const settled = await waitForWorkspaceSettled(h.db, created.id)
    expect(settled.state).toBe('error')
    expect(execute).not.toHaveBeenCalled()
  } finally {
    runtime.mockRestore()
  }
})
