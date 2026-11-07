import { contextBridge, ipcRenderer } from 'electron'
import {
  SESSION_EVENT_CHANNEL,
  SESSION_QUEUE_CHANNEL,
  SESSION_TITLE_CHANNEL,
  TERMINAL_DATA_CHANNEL,
  TERMINAL_EXIT_CHANNEL,
  WORKSPACE_STATE_CHANNEL,
  type IpcContract,
  type LoomApi,
  type SessionEventPush,
  type SessionQueuePush,
  type SessionTitlePush,
  type TerminalDataPush,
  type TerminalExitPush,
  type WorkspaceStatePush
} from '../shared/ipc-contract'

function invoke<K extends keyof IpcContract>(
  channel: K,
  input: IpcContract[K]['in']
): Promise<IpcContract[K]['out']> {
  return ipcRenderer.invoke(channel, input) as Promise<IpcContract[K]['out']>
}

function subscribe<T>(channel: string, cb: (push: T) => void): () => void {
  const listener = (_e: unknown, push: T) => cb(push)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

const api: LoomApi = {
  ping: () => invoke('app:ping', undefined),
  secrets: {
    has: (provider) => invoke('secrets:has', { provider }),
    set: (provider, value) => invoke('secrets:set', { provider, value }),
    delete: (provider) => invoke('secrets:delete', { provider })
  },
  providers: {
    status: () => invoke('providers:status', undefined),
    models: (backend) => invoke('providers:models', { backend })
  },
  integrations: {
    status: () => invoke('integrations:status', undefined)
  },
  github: {
    prs: (projectId, query) => invoke('github:prs', { projectId, query: query ?? null }),
    workspacePr: (workspaceId) => invoke('github:workspacePr', { workspaceId })
  },
  linear: {
    hasKey: () => invoke('linear:hasKey', undefined),
    setKey: (value) => invoke('linear:setKey', { value }),
    deleteKey: () => invoke('linear:deleteKey', undefined),
    issues: (query) => invoke('linear:issues', { query: query ?? null })
  },
  projects: {
    list: () => invoke('projects:list', undefined),
    add: (input) => invoke('projects:add', input),
    remove: (id, deleteRepo) => invoke('projects:remove', { id, deleteRepo }),
    repoOwned: (id) => invoke('projects:repoOwned', { id }),
    pickFolder: () => invoke('projects:pickFolder', undefined),
    quickstart: (name) => invoke('projects:quickstart', { name }),
    clone: (url, location, overwrite) => invoke('projects:clone', { url, location, overwrite }),
    setPrompts: (input) => invoke('projects:setPrompts', input)
  },
  instructions: {
    get: (scope, projectId) => invoke('instructions:get', { scope, projectId: projectId ?? null }),
    set: (scope, projectId, text) => invoke('instructions:set', { scope, projectId: projectId ?? null, text })
  },
  shell: {
    openExternal: (url) => invoke('shell:openExternal', { url })
  },
  workspaces: {
    list: (projectId) => invoke('workspaces:list', { projectId }),
    add: (projectId, name, baseRef) =>
      invoke('workspaces:add', { projectId, name, baseRef: baseRef ?? null }),
    remove: (id) => invoke('workspaces:remove', { id }),
    setArchived: (id, archived) => invoke('workspaces:setArchived', { id, archived }),
    scripts: (workspaceId) => invoke('workspaces:scripts', { workspaceId }),
    runAction: (workspaceId, actionId) => invoke('workspaces:runAction', { workspaceId, actionId })
  },
  git: {
    branches: (projectId) => invoke('git:branches', { projectId }),
    status: (workspaceId) => invoke('git:status', { workspaceId }),
    diff: (workspaceId, path) => invoke('git:diff', { workspaceId, path }),
    checkpoints: (workspaceId) => invoke('git:checkpoints', { workspaceId }),
    saveCheckpoint: (workspaceId, label) => invoke('git:saveCheckpoint', { workspaceId, label }),
    restoreCheckpoint: (workspaceId, id) => invoke('git:restoreCheckpoint', { workspaceId, id }),
    diffCheckpoint: (workspaceId, id) => invoke('git:diffCheckpoint', { workspaceId, id })
  },
  sessions: {
    list: (workspaceId) => invoke('sessions:list', { workspaceId }),
    create: (input) => invoke('sessions:create', input),
    send: (sessionId, text, attachments) =>
      invoke('sessions:send', { sessionId, text, attachments: attachments ?? [] }),
    sendNow: (sessionId, text, attachments) =>
      invoke('sessions:sendNow', { sessionId, text, attachments: attachments ?? [] }),
    cancel: (sessionId) => invoke('sessions:cancel', { sessionId }),
    events: (sessionId) => invoke('sessions:events', { sessionId }),
    exportMarkdown: (sessionId) => invoke('sessions:exportMarkdown', { sessionId }),
    fork: (input) => invoke('sessions:fork', input),
    close: (sessionId) => invoke('sessions:close', { sessionId }),
    closed: (workspaceId) => invoke('sessions:closed', { workspaceId }),
    reopen: (sessionId) => invoke('sessions:reopen', { sessionId }),
    queue: (sessionId) => invoke('sessions:queue', { sessionId }),
    dequeue: (sessionId, index) => invoke('sessions:dequeue', { sessionId, index })
  },
  comments: {
    list: (workspaceId) => invoke('comments:list', { workspaceId }),
    add: (input) => invoke('comments:add', input),
    remove: (id) => invoke('comments:remove', { id })
  },
  files: {
    tree: (workspaceId) => invoke('files:tree', { workspaceId }),
    listDir: (workspaceId, path) => invoke('files:listDir', { workspaceId, path }),
    read: (workspaceId, path) => invoke('files:read', { workspaceId, path }),
    pickExternal: () => invoke('files:pickExternal', undefined)
  },
  env: {
    list: (scope, projectId) => invoke('env:list', { scope, projectId }),
    set: (scope, projectId, name, value) => invoke('env:set', { scope, projectId, name, value }),
    delete: (scope, projectId, name) => invoke('env:delete', { scope, projectId, name })
  },
  lint: {
    run: (workspaceId, path, text) => invoke('lint:run', { workspaceId, path, text })
  },
  terminal: {
    create: (workspaceId) => invoke('terminal:create', { workspaceId }),
    attach: (workspaceId, text) => invoke('terminal:attach', { workspaceId, text }),
    write: (id, data) => invoke('terminal:write', { id, data }),
    resize: (id, cols, rows) => invoke('terminal:resize', { id, cols, rows }),
    destroy: (id) => invoke('terminal:destroy', { id }),
    setActive: (id) => invoke('terminal:setActive', { id })
  },
  history: {
    search: (query, projectId) => invoke('history:search', { query, projectId })
  },
  onSessionEvent: (cb) => subscribe<SessionEventPush>(SESSION_EVENT_CHANNEL, cb),
  onTerminalData: (cb) => subscribe<TerminalDataPush>(TERMINAL_DATA_CHANNEL, cb),
  onTerminalExit: (cb) => subscribe<TerminalExitPush>(TERMINAL_EXIT_CHANNEL, cb),
  onWorkspaceState: (cb) => subscribe<WorkspaceStatePush>(WORKSPACE_STATE_CHANNEL, cb),
  onSessionQueue: (cb) => subscribe<SessionQueuePush>(SESSION_QUEUE_CHANNEL, cb),
  onSessionTitle: (cb) => subscribe<SessionTitlePush>(SESSION_TITLE_CHANNEL, cb)
}

contextBridge.exposeInMainWorld('loom', api)
