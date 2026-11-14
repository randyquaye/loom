import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  CLOUD_STATUS_CHANNEL,
  SESSION_EVENT_CHANNEL,
  SESSION_ACTIVITY_CHANNEL,
  SESSION_QUEUE_CHANNEL,
  SESSION_TITLE_CHANNEL,
  TERMINAL_DATA_CHANNEL,
  TERMINAL_EXIT_CHANNEL,
  WORKSPACE_STATE_CHANNEL,
  WORKSPACE_POWER_CHANNEL,
  type CloudStatus,
  type IpcContract,
  type LoomApi,
  type SessionEventPush,
  type SessionActivity,
  type SessionQueuePush,
  type SessionTitlePush,
  type TerminalDataPush,
  type TerminalExitPush,
  type WorkspaceStatePush,
  type WorkspacePowerPush
} from '../shared/ipc-contract'
import { NOTIFICATION_CHANNEL, type Notification } from '../shared/notifications'

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
    prs: (projectId, query, cloud) => invoke('github:prs', { projectId, query: query ?? null, cloud }),
    workspacePr: (workspaceId) => invoke('github:workspacePr', { workspaceId }),
    branchPrs: (projectId, cloud) => invoke('github:branchPrs', { projectId, cloud })
  },
  linear: {
    hasKey: () => invoke('linear:hasKey', undefined),
    setKey: (value) => invoke('linear:setKey', { value }),
    deleteKey: () => invoke('linear:deleteKey', undefined),
    issues: (query) => invoke('linear:issues', { query: query ?? null })
  },
  elevenlabs: {
    hasKey: () => invoke('elevenlabs:hasKey', undefined),
    setKey: (value) => invoke('elevenlabs:setKey', { value }),
    deleteKey: () => invoke('elevenlabs:deleteKey', undefined),
    sttToken: () => invoke('elevenlabs:sttToken', undefined),
    ttsToken: () => invoke('elevenlabs:ttsToken', undefined)
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
    power: (workspaceId) => invoke('workspaces:power', { workspaceId }),
    start: (workspaceId) => invoke('workspaces:start', { workspaceId }),
    stop: (workspaceId) => invoke('workspaces:stop', { workspaceId }),
    list: (projectId) => invoke('workspaces:list', { projectId }),
    add: (projectId, name, baseRef, cloud, modes) =>
      invoke('workspaces:add', { projectId, name, baseRef: baseRef ?? null, cloud: cloud ?? false, modes }),
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
    activity: () => invoke('sessions:activity', undefined),
    unread: () => invoke('sessions:unread', undefined),
    markRead: (sessionId, seq) => invoke('sessions:markRead', { sessionId, seq }),
    list: (workspaceId) => invoke('sessions:list', { workspaceId }),
    create: (input) => invoke('sessions:create', input),
    send: (sessionId, text, attachments) =>
      invoke('sessions:send', { sessionId, text, attachments: attachments ?? [] }),
    steer: (sessionId, text, attachments) =>
      invoke('sessions:steer', { sessionId, text, attachments: attachments ?? [] }),
    steerQueued: (sessionId, messageId) => invoke('sessions:steerQueued', { sessionId, messageId }),
    answerQuestion: (sessionId, answer) => invoke('sessions:answerQuestion', { sessionId, answer }),
    sendNow: (sessionId, text, attachments) =>
      invoke('sessions:sendNow', { sessionId, text, attachments: attachments ?? [] }),
    cancel: (sessionId) => invoke('sessions:cancel', { sessionId }),
    events: (sessionId) => invoke('sessions:events', { sessionId }),
    eventsAfter: (sessionId, afterSeq) => invoke('sessions:eventsAfter', { sessionId, afterSeq }),
    instructions: (sessionId) => invoke('sessions:instructions', { sessionId }),
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
    pathsForFiles: (files) => files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
    tree: (workspaceId) => invoke('files:tree', { workspaceId }),
    listDir: (workspaceId, path) => invoke('files:listDir', { workspaceId, path }),
    read: (workspaceId, path) => invoke('files:read', { workspaceId, path }),
    preview: (workspaceId, path) => invoke('files:preview', { workspaceId, path }),
    reveal: (workspaceId, path) => invoke('files:reveal', { workspaceId, path }),
    pickExternal: () => invoke('files:pickExternal', undefined)
  },
  env: {
    list: (scope, projectId, cloud) => invoke('env:list', { scope, projectId, cloud: cloud ?? false }),
    set: (scope, projectId, name, value, cloud) =>
      invoke('env:set', { scope, projectId, name, value, cloud: cloud ?? false }),
    delete: (scope, projectId, name, cloud) =>
      invoke('env:delete', { scope, projectId, name, cloud: cloud ?? false })
  },
  lint: {
    run: (workspaceId, path, text) => invoke('lint:run', { workspaceId, path, text })
  },
  terminal: {
    create: (workspaceId) => invoke('terminal:create', { workspaceId }),
    list: (workspaceId) => invoke('terminal:list', { workspaceId }),
    attach: (workspaceId, text) => invoke('terminal:attach', { workspaceId, text }),
    write: (id, data) => invoke('terminal:write', { id, data }),
    resize: (id, cols, rows) => invoke('terminal:resize', { id, cols, rows }),
    destroy: (id) => invoke('terminal:destroy', { id }),
    setActive: (id) => invoke('terminal:setActive', { id })
  },
  history: {
    search: (query, projectId) => invoke('history:search', { query, projectId })
  },
  notifications: {
    list: () => invoke('notifications:list', undefined),
    read: () => invoke('notifications:read', undefined),
    answer: (id, answer) => invoke('notifications:answer', { id, answer })
  },
  cloud: {
    health: () => invoke('cloud:health', undefined),
    status: () => invoke('cloud:status', undefined),
    runner: () => invoke('cloud:runner', undefined),
    setRunner: (url, expectedEmail = '') => invoke('cloud:setRunner', { url, expectedEmail }),
    signIn: (expectedEmail = '') => invoke('cloud:signIn', { expectedEmail }),
    signOut: () => invoke('cloud:signOut', undefined),
    previewInvite: (code) => invoke('cloud:previewInvite', { code }),
    join: (code, expectedEmail = '') => invoke('cloud:join', { code, expectedEmail })
  },
  org: {
    get: () => invoke('org:get', undefined),
    update: (name) => invoke('org:update', { name }),
    members: () => invoke('org:members', undefined),
    invite: (email) => invoke('org:invite', { email }),
    invites: () => invoke('org:invites', undefined),
    revokeInvite: (id) => invoke('org:revokeInvite', { id }),
    setRole: (userId, role) => invoke('org:setRole', { userId, role }),
    removeMember: (userId) => invoke('org:removeMember', { userId }),
    purgeMember: (userId) => invoke('org:purgeMember', { userId }),
    log: (before) => invoke('org:log', { before })
  },
  logins: {
    status: () => invoke('logins:status', undefined),
    connectClaude: (token) => invoke('logins:connectClaude', { token }),
    connectCodex: () => invoke('logins:connectCodex', undefined),
    connectGithub: () => invoke('logins:connectGithub', undefined),
    checkGithub: () => invoke('logins:checkGithub', undefined),
    disconnect: (provider) => invoke('logins:disconnect', { provider })
  },
  onCloudStatus: (cb) => subscribe<CloudStatus>(CLOUD_STATUS_CHANNEL, cb),
  ports: {
    list: (workspaceId) => invoke('ports:list', { workspaceId }),
    forward: (workspaceId, port, localPort) =>
      invoke('ports:forward', {
        workspaceId,
        port,
        ...(localPort === undefined ? {} : { localPort })
      }),
    unforward: (workspaceId, port) => invoke('ports:unforward', { workspaceId, port })
  },
  onWorkspacePower: (cb) => subscribe<WorkspacePowerPush>(WORKSPACE_POWER_CHANNEL, cb),
  onNotification: (cb) => subscribe<Notification>(NOTIFICATION_CHANNEL, cb),
  onSessionEvent: (cb) => subscribe<SessionEventPush>(SESSION_EVENT_CHANNEL, cb),
  onSessionActivity: (cb) => subscribe<SessionActivity>(SESSION_ACTIVITY_CHANNEL, cb),
  onTerminalData: (cb) => subscribe<TerminalDataPush>(TERMINAL_DATA_CHANNEL, cb),
  onTerminalExit: (cb) => subscribe<TerminalExitPush>(TERMINAL_EXIT_CHANNEL, cb),
  onWorkspaceState: (cb) => subscribe<WorkspaceStatePush>(WORKSPACE_STATE_CHANNEL, cb),
  onSessionQueue: (cb) => subscribe<SessionQueuePush>(SESSION_QUEUE_CHANNEL, cb),
  onSessionTitle: (cb) => subscribe<SessionTitlePush>(SESSION_TITLE_CHANNEL, cb)
}

contextBridge.exposeInMainWorld('loom', api)
