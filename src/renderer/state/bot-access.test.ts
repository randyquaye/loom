import { afterEach, expect, it, vi } from 'vitest'
import type {
  FilePreview,
  NumberedSessionEventPush,
  SequencedEvent,
  SessionActivity,
  SessionRow,
  SessionUnread,
  WorkspaceRow
} from '../../shared/ipc-contract'

const tab = (workspaceId: string): SessionRow => ({
  id: `${workspaceId}-session`,
  workspaceId,
  backend: 'codex',
  model: 'gpt-6.1-sol',
  effort: 'high',
  title: workspaceId,
  createdAt: 1,
  closedAt: null,
  forkedFrom: null,
  providerSessionId: null
})
const event = (text: string): SequencedEvent => ({
  seq: 1,
  event: { type: 'text.done', turnId: 'turn', text }
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(activity?: Promise<SessionActivity>) {
  vi.resetModules()
  let push!: (value: NumberedSessionEventPush) => void
  let pushActivity!: (value: SessionActivity) => void
  let botsChanged!: () => void
  const api = {
    bots: { list: vi.fn(async () => []) },
    onBotsChanged: vi.fn((listener: () => void) => {
      botsChanged = listener
      return vi.fn()
    }),
    onSessionEvent: (listener: typeof push) => {
      push = listener
    },
    onSessionTitle: vi.fn(),
    onWorkspaceState: vi.fn(),
    onSessionActivity: (listener: typeof pushActivity) => {
      pushActivity = listener
    },
    sessions: {
      list: vi.fn(async (workspaceId: string) => [tab(workspaceId)]),
      eventsAfter: vi.fn(async (sessionId: string, _after: number): Promise<SequencedEvent[]> => [
        event(sessionId)
      ]),
      activity: vi.fn(async (): Promise<SessionActivity> => activity ?? { revision: 0, bySession: {} }),
      unread: vi.fn(async (): Promise<Record<string, SessionUnread>> => ({})),
      markRead: vi.fn(async () => {})
    },
    files: {
      preview: vi.fn(async (): Promise<FilePreview> => ({
        kind: 'text',
        text: 'fresh content',
        language: 'typescript'
      })),
      tree: vi.fn(async () => []),
      listDir: vi.fn(async () => [])
    },
    git: {
      status: vi.fn(async () => []),
      diff: vi.fn(async () => 'fresh diff'),
      diffCheckpoint: vi.fn(async () => 'checkpoint')
    },
    lint: { run: vi.fn(async () => []) }
  }
  vi.stubGlobal('window', { loom: api })
  const { useSessions, subscribeSessionEvents } = await import('./sessions')
  const { useFiles, cacheKey } = await import('./files')
  const { useProjects } = await import('./projects')
  subscribeSessionEvents(() => false)
  return {
    useSessions,
    useFiles,
    useProjects,
    cacheKey,
    api,
    push: (value: NumberedSessionEventPush) => push(value),
    pushActivity: (value: SessionActivity) => pushActivity(value),
    botsChanged: () => botsChanged()
  }
}
afterEach(() => vi.unstubAllGlobals())

it('forgets pending bot history and reloads from zero while preserving a personal workspace', async () => {
  const f = await fixture()
  await f.useSessions.getState().load('personal')
  const old = deferred<SequencedEvent[]>()
  f.api.sessions.eventsAfter.mockImplementationOnce(() => old.promise)
  const previousLoad = f.useSessions.getState().load('bot')
  await vi.waitFor(() => expect(f.api.sessions.eventsAfter).toHaveBeenCalledWith('bot-session', 0))
  f.useSessions.setState({
    unreadBySession: { 'bot-session': { workspaceId: 'bot', seq: 1, eventId: 1 } },
    activity: { revision: 2, bySession: { 'bot-session': 'bot', 'personal-session': 'personal' } }
  })
  f.useSessions.getState().forgetWorkspaces(['bot'])
  f.push({ sessionId: 'never-listed', workspaceId: 'bot', ...event('late private push') })
  expect(f.useSessions.getState().eventsBySession['bot-session']).toBeUndefined()
  expect(f.useSessions.getState().unreadBySession['bot-session']).toBeUndefined()
  expect(f.useSessions.getState().eventsBySession['never-listed']).toBeUndefined()
  expect(f.useSessions.getState().activity.bySession).toEqual({ 'personal-session': 'personal' })
  f.push({
    sessionId: 'bot-session',
    ...event('revoked push'),
    unread: { workspaceId: 'bot', seq: 1, eventId: 2 }
  })
  expect(f.useSessions.getState().eventsBySession['bot-session']).toBeUndefined()
  await f.useSessions.getState().load('bot')
  old.resolve([event('old private history')])
  await previousLoad
  expect(
    f.api.sessions.eventsAfter.mock.calls.filter(([id]) => id === 'bot-session').map(([, after]) => after)
  ).toEqual([0, 0])
  expect(f.useSessions.getState().eventsBySession['bot-session']).toEqual([event('bot-session').event])
  expect(f.useSessions.getState().eventsBySession['personal-session']).toEqual([
    event('personal-session').event
  ])
})

it('ignores an old activity snapshot after forgetting and freshly loading the same workspace', async () => {
  const old = deferred<SessionActivity>()
  const f = await fixture(old.promise)
  f.useSessions.getState().forgetWorkspaces(['bot'])
  await f.useSessions.getState().load('bot')
  old.resolve({ revision: 5, bySession: { 'bot-session': 'bot', 'personal-session': 'personal' } })
  await vi.waitFor(() => expect(f.useSessions.getState().activity.revision).toBe(5))
  expect(f.useSessions.getState().activity.bySession).toEqual({ 'personal-session': 'personal' })
})

it('opens bot files for viewers without executing lint while personal files retain linting', async () => {
  const f = await fixture()
  const workspace: WorkspaceRow = {
    id: 'bot',
    projectId: 'project',
    name: 'Bot',
    branch: 'loom/bot',
    worktreePath: '/tmp/bot',
    createdAt: 1,
    archived: false,
    state: 'ready',
    port: null,
    initializationFilesCopied: null,
    setupLogPath: null,
    checkout: 'clone',
    runtime: 'container',
    ownerId: 'robot',
    bot: { id: 'robot', access: 'view' }
  }
  f.useProjects.setState({ workspacesByProject: { project: [workspace] } })
  expect(await f.useFiles.getState().open('personal', 'private.ts')).toBe(true)
  expect(f.api.lint.run).toHaveBeenCalledTimes(1)
  expect(await f.useFiles.getState().open('bot', 'view.ts')).toBe(true)
  expect(f.useFiles.getState().contentByPath[f.cacheKey('bot', 'view.ts')]).toMatchObject({
    text: 'fresh content'
  })
  expect(f.api.lint.run).toHaveBeenCalledTimes(1)
})

it('discards delayed session lists and unread snapshots for revoked workspaces', async () => {
  const f = await fixture()
  const list = deferred<SessionRow[]>()
  const unread = deferred<Record<string, SessionUnread>>()
  f.api.sessions.list.mockImplementationOnce(() => list.promise)
  f.api.sessions.unread.mockImplementationOnce(() => unread.promise)
  const loading = f.useSessions.getState().load('bot')
  const loadingUnread = f.useSessions.getState().loadUnread()
  f.useSessions.getState().forgetWorkspaces(['bot'])
  list.resolve([tab('bot')])
  unread.resolve({
    'bot-session': { workspaceId: 'bot', seq: 1, eventId: 1 },
    'personal-session': { workspaceId: 'personal', seq: 1, eventId: 2 }
  })
  await Promise.all([loading, loadingUnread])
  expect(f.useSessions.getState().sessionsByWorkspace.bot).toBeUndefined()
  expect(f.useSessions.getState().activeSessionByWorkspace.bot).toBeUndefined()
  expect(f.useSessions.getState().unreadBySession['bot-session']).toBeUndefined()
  expect(f.useSessions.getState().unreadBySession['personal-session']?.seq).toBe(1)
  expect(f.api.sessions.eventsAfter).not.toHaveBeenCalled()
  f.pushActivity({ revision: 3, bySession: { 'bot-session': 'bot', 'personal-session': 'personal' } })
  expect(f.useSessions.getState().activity.bySession).toEqual({ 'personal-session': 'personal' })
})

it('fences delayed file previews and trees and allows fresh loads after access returns', async () => {
  const f = await fixture()
  await f.useFiles.getState().open('personal', 'private.ts')
  const preview = deferred<FilePreview>()
  const tree = deferred<never[]>()
  f.api.files.preview.mockImplementationOnce(() => preview.promise)
  f.api.files.tree.mockImplementationOnce(() => tree.promise)
  const opening = f.useFiles.getState().open('bot', 'secret.ts')
  const loadingTree = f.useFiles.getState().loadTree('bot')
  f.useFiles.getState().forgetWorkspaces(['bot'])
  preview.resolve({ kind: 'text', text: 'old secret', language: 'typescript' })
  tree.resolve([])
  expect(await opening).toBe(false)
  await loadingTree
  expect(f.useFiles.getState().contentByPath[f.cacheKey('bot', 'secret.ts')]).toBeUndefined()
  expect(f.useFiles.getState().openPathByWorkspace.bot).toBeUndefined()
  expect(f.useFiles.getState().treeByWorkspace.bot).toBeUndefined()
  expect(f.useFiles.getState().openPathByWorkspace.personal).toBe('private.ts')
  expect(f.api.lint.run).toHaveBeenCalledTimes(1)
  await f.useFiles.getState().open('bot', 'secret.ts')
  expect(f.useFiles.getState().contentByPath[f.cacheKey('bot', 'secret.ts')]).toMatchObject({
    text: 'fresh content'
  })
})

it('clears bot-private caches when connected capabilities disappear without asking an unsupported runner', async () => {
  const f = await fixture()
  const { useCloud } = await import('./cloud')
  const { useUi } = await import('./ui')
  const { watchBotAccess } = await import('../routes/settings/BotsPage')
  const personal = {
    id: 'personal',
    projectId: 'personal-project',
    name: 'Personal',
    branch: 'loom/personal',
    worktreePath: '/tmp/personal',
    createdAt: 1,
    archived: false,
    state: 'ready',
    port: null,
    initializationFilesCopied: null,
    setupLogPath: null,
    checkout: 'clone',
    runtime: 'container',
    ownerId: 'owner',
    cloud: true
  } satisfies WorkspaceRow
  const bot: WorkspaceRow = {
    ...personal,
    id: 'bot',
    projectId: 'loom-bot-project:remote',
    bot: { id: 'robot', access: 'control' }
  }
  f.useProjects.setState({
    workspacesByProject: { 'personal-project': [personal], 'loom-bot-project:remote': [bot] }
  })
  await f.useSessions.getState().load('personal')
  await f.useSessions.getState().load('bot')
  await f.useFiles.getState().open('personal', 'personal.ts')
  await f.useFiles.getState().open('bot', 'secret.ts')
  useUi.setState({
    route: { name: 'workspace', workspaceId: 'bot' },
    draftBySession: { 'bot-session': 'private draft', 'personal-session': 'personal draft' },
    attachmentsBySession: { 'bot-session': ['secret.txt'], 'personal-session': ['mine.txt'] },
    questionDrafts: { 'bot-session:question': { selected: {}, text: { answer: 'secret' } } }
  })
  useCloud.setState({ status: { state: 'connected', capabilities: ['bots.v1'] } })
  const stop = watchBotAccess()
  try {
    useCloud.setState({ status: { state: 'connected' } })
    expect(f.useProjects.getState().workspacesByProject['loom-bot-project:remote']).toEqual([])
    expect(f.useProjects.getState().workspacesByProject['personal-project']).toEqual([personal])
    expect(f.useSessions.getState().eventsBySession['bot-session']).toBeUndefined()
    expect(f.useSessions.getState().eventsBySession['personal-session']).toHaveLength(1)
    expect(f.useFiles.getState().contentByPath[f.cacheKey('bot', 'secret.ts')]).toBeUndefined()
    expect(f.useFiles.getState().contentByPath[f.cacheKey('personal', 'personal.ts')]).toBeDefined()
    expect(useUi.getState().draftBySession).toEqual({ 'personal-session': 'personal draft' })
    expect(useUi.getState().attachmentsBySession).toEqual({ 'personal-session': ['mine.txt'] })
    expect(useUi.getState().questionDrafts).toEqual({})
    expect(useUi.getState().route).toEqual({ name: 'home' })
    f.botsChanged()
    await Promise.resolve()
    expect(f.api.bots.list).not.toHaveBeenCalled()
  } finally {
    stop()
  }
})
