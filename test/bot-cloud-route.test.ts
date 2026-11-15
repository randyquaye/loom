import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerClientOptions } from '../src/main/cloud/client'
import type * as RunnerClientModule from '../src/main/cloud/client'
import type { BotWorkspace } from '../src/shared/ipc-contract'

const harness = vi.hoisted(() => ({
  call: vi.fn(),
  options: null as RunnerClientOptions | null,
  closeWorkspace: vi.fn()
}))
vi.mock('../src/main/cloud/port-forwards', () => ({
  createPortForwards: () => ({
    list: () => [],
    forward: vi.fn(),
    unforward: vi.fn(),
    disconnect: vi.fn(),
    clear: async () => {},
    close: async () => {},
    closeWorkspace: harness.closeWorkspace
  })
}))
vi.mock('../src/main/cloud/client', async (original) => ({
  ...(await original<typeof RunnerClientModule>()),
  connectRunner: (options: RunnerClientOptions) => {
    harness.options = options
    return { call: harness.call, callIdentified: harness.call, reconnect: vi.fn(), close: vi.fn() }
  }
}))

import { openDb } from '../src/main/db'
import { createCloudRoute, type CloudRoute } from '../src/main/cloud/route'
import { RunnerUnreachableError } from '../src/main/cloud/client'
import { register } from '../src/main/ipc/registry'
import { BOTS_CHANGED_CHANNEL, ipcSchemas } from '../src/shared/ipc-contract'
import { robotConfig } from '../src/shared/bots'

let db: ReturnType<typeof openDb>
let route: CloudRoute
function opened(): BotWorkspace {
  return {
    invocation: {
      id: 'invocation',
      botId: 'robot',
      requesterId: 'owner',
      requestKey: 'key',
      fingerprint: 'fingerprint',
      configRevision: 1,
      config: { ...robotConfig(), repositories: ['example/repo'] },
      repository: 'example/repo',
      prompt: 'Explain',
      workspaceId: 'remote-workspace',
      sessionId: 'remote-session',
      messageId: 'message',
      state: 'ready',
      error: null,
      createdAt: 1,
      updatedAt: 1
    },
    project: {
      id: 'remote-project',
      name: 'repo',
      repoPath: 'https://github.com/example/repo.git',
      remoteUrl: 'https://github.com/example/repo.git',
      createdAt: 1,
      customPromptGeneral: null,
      customPromptCodeReview: null,
      customPromptFixErrors: null
    },
    workspace: {
      id: 'remote-workspace',
      projectId: 'remote-project',
      name: 'Robot task',
      branch: 'loom/task',
      worktreePath: '/remote/task',
      createdAt: 1,
      archived: false,
      state: 'ready',
      port: 4100,
      initializationFilesCopied: null,
      setupLogPath: null,
      checkout: 'clone',
      runtime: 'container',
      ownerId: 'robot',
      bot: { id: 'robot', access: 'control' }
    },
    session: null
  }
}

beforeEach(() => {
  harness.closeWorkspace.mockReset()
  db = openDb(':memory:')
  for (const [channel, schema] of Object.entries(ipcSchemas))
    register<unknown, unknown>(channel, schema, () => (channel === 'workspaces:list' ? [] : undefined))
  harness.call.mockReset().mockImplementation(async (channel) => {
    if (channel === 'bots:open') return opened()
    if (channel === 'workspaces:list') return [opened().workspace]
    if (channel === 'sessions:activity') return { revision: 0, bySession: {} }
    return undefined
  })
  route = createCloudRoute({
    db,
    dataRoot: '/unused',
    url: 'ws://127.0.0.1',
    token: async () => 'fixture',
    toWindow: vi.fn()
  })
  harness.options!.onState({ state: 'connected', capabilities: ['bots.v1'] })
})
afterEach(() => {
  route.close()
  db.close()
})

describe('bot desktop cloud routing', () => {
  it('keeps personal cloud listing working with a baseline runner advertising no capabilities', async () => {
    db.prepare(
      "INSERT INTO projects(id,name,repo_path,remote_url,created_at) VALUES ('local','repo','/local','https://github.com/example/repo.git',0)"
    ).run()
    const personal = { ...opened().workspace!, id: 'personal-workspace', ownerId: 'owner' }
    delete personal.bot
    harness.call.mockImplementation(async (channel, input) => {
      if (channel === 'projects:ensure') return opened().project
      if (channel === 'workspaces:list' && input.projectId === 'remote-project') return [personal]
      if (channel === 'sessions:activity') return { revision: 0, bySession: {} }
      throw new Error(`Baseline runner does not implement ${channel}`)
    })
    harness.options!.onState({ state: 'connected' })
    expect(await route.route('workspaces:list', { projectId: 'local' })).toMatchObject([
      { id: 'personal-workspace', cloud: true }
    ])
    expect(harness.call.mock.calls.some(([channel]) => channel.startsWith('bots:'))).toBe(false)
  })

  it('drops cached bot routing when a connected runner no longer advertises bots', async () => {
    const result = (await route.route('bots:open', { invocationId: 'invocation' })) as BotWorkspace
    harness.options!.onState({ state: 'connected' })
    harness.call.mockClear()
    expect(await route.route('workspaces:list', { projectId: result.project!.id })).toEqual([])
    expect(harness.closeWorkspace).toHaveBeenCalledWith('remote-workspace')
    expect(harness.call).not.toHaveBeenCalledWith('workspaces:list', expect.anything())
  })

  it('does not return a cached bot snapshot when a delayed request fails after capability loss', async () => {
    const result = (await route.route('bots:open', { invocationId: 'invocation' })) as BotWorkspace
    let reject!: (reason: Error) => void
    harness.call.mockImplementation((channel) =>
      channel === 'workspaces:list'
        ? new Promise((_resolve, fail) => {
            reject = fail
          })
        : Promise.resolve({ revision: 0, bySession: {} })
    )
    const listing = route.route('workspaces:list', { projectId: result.project!.id }) as Promise<unknown>
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    harness.options!.onState({ state: 'connected' })
    reject(new RunnerUnreachableError())
    expect(await listing).toEqual([])
  })

  it('keeps personal cloud project mappings separate from a bot canonical repository alias', async () => {
    db.prepare(
      "INSERT INTO projects(id,name,repo_path,remote_url,created_at) VALUES ('local','repo','/local','git@github.com:Example/Repo.git',0)"
    ).run()
    const personal = {
      ...opened().workspace!,
      id: 'personal-workspace',
      projectId: 'personal-runner',
      ownerId: 'owner'
    }
    delete personal.bot
    harness.call.mockImplementation(async (channel, input) => {
      if (channel === 'projects:ensure') return { ...opened().project!, id: 'personal-runner' }
      if (channel === 'bots:open') return opened()
      if (channel === 'workspaces:list')
        return input.projectId === 'personal-runner' ? [personal] : [opened().workspace]
      return undefined
    })
    expect(await route.route('workspaces:list', { projectId: 'local' })).toMatchObject([
      { id: 'personal-workspace' }
    ])
    const bot = (await route.route('bots:open', { invocationId: 'invocation' })) as BotWorkspace
    expect(bot.project!.id).toBe('loom-bot-project:remote-project')
    expect(await route.route('workspaces:list', { projectId: 'local' })).toMatchObject([
      { id: 'personal-workspace' }
    ])
  })

  it('keeps existing previews and cached bot routing when another launch only updates metadata', async () => {
    await route.route('bots:open', { invocationId: 'invocation' })
    harness.options!.onPush(BOTS_CHANGED_CHANNEL, { botId: 'robot', accessChanged: false })
    expect(harness.closeWorkspace).not.toHaveBeenCalled()
    await route.route('sessions:create', {
      workspaceId: 'remote-workspace',
      backend: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      title: 'Follow-up'
    })
    expect(harness.call).toHaveBeenCalledWith(
      'sessions:create',
      expect.objectContaining({ instructions: { overlay: [], general: null } })
    )
  })
  it('rejects a workspace list overtaken by revocation instead of repopulating shared rows', async () => {
    const result = (await route.route('bots:open', { invocationId: 'invocation' })) as BotWorkspace
    let resolve!: (value: unknown) => void
    harness.call.mockImplementation((channel) =>
      channel === 'workspaces:list'
        ? new Promise((done) => {
            resolve = done
          })
        : Promise.resolve([])
    )
    const listing = route.route('workspaces:list', { projectId: result.project!.id }) as Promise<unknown>
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    harness.options!.onPush(BOTS_CHANGED_CHANNEL, { botId: 'robot' })
    resolve([opened().workspace])
    await expect(listing).rejects.toThrow(/access changed/i)
  })
  it('opens shared projects without a local clone and refreshes their cloud workspaces', async () => {
    const result = (await route.route('bots:open', { invocationId: 'invocation' })) as BotWorkspace
    expect(result.workspace).toMatchObject({ cloud: true, projectId: 'loom-bot-project:remote-project' })
    expect(result.project).toMatchObject({ id: 'loom-bot-project:remote-project', repoPath: '' })
    expect(await route.route('workspaces:list', { projectId: result.project!.id })).toMatchObject([
      { id: 'remote-workspace', cloud: true }
    ])
    expect(harness.call).toHaveBeenCalledWith('workspaces:list', { projectId: 'remote-project' })
  })

  it('never reads or forwards the invoking desktop personal instruction overlay for bot tabs', async () => {
    await route.route('bots:open', { invocationId: 'invocation' })
    await route.route('sessions:create', {
      workspaceId: 'remote-workspace',
      backend: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      title: 'Follow-up'
    })
    expect(harness.call).toHaveBeenCalledWith(
      'sessions:create',
      expect.objectContaining({ instructions: { overlay: [], general: null } })
    )
  })

  it('does not cache an open response overtaken by a bot grant change', async () => {
    let resolve!: (value: BotWorkspace) => void
    harness.call.mockImplementation((channel) =>
      channel === 'bots:open'
        ? new Promise<BotWorkspace>((done) => {
            resolve = done
          })
        : Promise.resolve([])
    )
    const opening = route.route('bots:open', { invocationId: 'invocation' }) as Promise<BotWorkspace>
    harness.options!.onPush(BOTS_CHANGED_CHANNEL, { botId: 'robot' })
    resolve(opened())
    await expect(opening).rejects.toThrow(/access changed/i)
  })
})
