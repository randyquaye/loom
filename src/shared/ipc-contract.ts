import { z } from 'zod'
import type { AgentEvent } from './events'
import { EFFORTS } from './models'
import type { AuthStatus, BackendId, Effort, ModelDescriptor } from './models'

export interface ProjectRow {
  id: string
  name: string
  repoPath: string
  remoteUrl: string | null
  createdAt: number
  /** Per-project flow prompts (W5); null means built-in default text. */
  customPromptGeneral: string | null
  customPromptCodeReview: string | null
  customPromptFixErrors: string | null
}

export interface ProjectPromptsInput {
  projectId: string
  general: string | null
  codeReview: string | null
  fixErrors: string | null
}

export interface WorkspaceRow {
  id: string
  projectId: string
  name: string
  branch: string
  worktreePath: string
  createdAt: number
  archived: boolean
  state: WorkspaceState
  port: number | null
  initializationFilesCopied: number | null
  setupLogPath: string | null
}

/** Run actions a repo's .loom/settings.toml exposes to the workspace topbar. */
export interface RepoScriptsInfo {
  runMode: 'concurrent' | 'nonconcurrent'
  actions: Array<{ id: string; icon: string | null; isDefault: boolean }>
}

export interface SessionRow {
  id: string
  workspaceId: string
  backend: BackendId
  model: string
  effort: string
  title: string
  createdAt: number
  closedAt: number | null
  forkedFrom: string | null
  providerSessionId: string | null
}

export interface FileNode {
  name: string
  path: string
  kind: 'dir' | 'file'
  children?: FileNode[]
}

/** One worktree change for the Changes tab; staged/unstaged can both be true. */
export interface ChangeEntry {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
  unstaged: boolean
}

/** One saved worktree checkpoint (private ref under refs/loom/checkpoints/). */
export interface CheckpointInfo {
  id: string
  label: string
  at: number
}

export type WorkspaceState = 'initializing' | 'setting_up' | 'ready' | 'error'

export interface Diagnostic {
  source: string
  severity: 'error' | 'warning' | 'info'
  message: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
}

export interface SecretPresence {
  present: boolean
  masked: string | null
}

/** Single-use realtime-STT token minted in main; the long-lived key never crosses the bridge. */
export type SttTokenResult =
  { kind: 'ok'; token: string } | { kind: 'needs-key' } | { kind: 'error'; message: string }

export interface HistoryHit {
  sessionId: string
  workspaceId: string
  projectId: string
  projectLabel: string
  sessionTitle: string
  snippet: string
  createdAt: number
}

/**
 * Why an integration list is empty, as data rather than an error: each case has its own
 * honest empty state in the renderer (install hint, sign-in hint, retry), and none of them
 * should surface as a red toast.
 */
export type IntegrationBlocker =
  /** The project's origin is not a github.com repository, so there is nothing to list. */
  | { kind: 'no-remote' }
  | { kind: 'not-installed'; hint: string }
  | { kind: 'not-authenticated'; hint: string }
  | { kind: 'failed'; message: string }

/** One open pull request, in the shape the picker and the workspace chip need. */
export interface PullRequestSummary {
  number: number
  title: string
  headRefName: string
  baseRefName: string
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  url: string
  author: string | null
  updatedAt: number
}

export type PullRequestListResult = { kind: 'ok'; pullRequests: PullRequestSummary[] } | IntegrationBlocker

/** One CI check, normalised from GitHub's two statusCheckRollup shapes (check runs and commit statuses). */
export interface PrCheck {
  name: string
  state: 'pending' | 'success' | 'failure' | 'cancelled' | 'skipped'
  detailsUrl: string | null
}

export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | 'none'

/** A pull request plus what the workspace panel shows: the review verdict and its CI checks. */
export interface PullRequestDetail extends PullRequestSummary {
  reviewDecision: ReviewDecision
  checks: PrCheck[]
}

/** `pullRequest: null` means this branch has no open PR yet, which is not an error. */
export type WorkspacePrResult = { kind: 'ok'; pullRequest: PullRequestDetail | null } | IntegrationBlocker

export type GithubStatus =
  | { state: 'ready'; account: string }
  | { state: 'not-installed'; hint: string }
  | { state: 'not-authenticated'; hint: string }
  | { state: 'error'; message: string }

export type LinearStatus =
  { state: 'ready' } | { state: 'needs-key'; hint: string } | { state: 'error'; message: string }

export type ElevenLabsStatus =
  { state: 'ready' } | { state: 'needs-key'; hint: string } | { state: 'error'; message: string }

/** Aggregate integration health, mirroring the `providers:status` shape. */
export interface IntegrationsStatus {
  github: GithubStatus
  linear: LinearStatus
  elevenlabs: ElevenLabsStatus
}

/** One Linear issue, in the shape the workspace picker needs. */
export interface LinearIssueSummary {
  id: string
  /** Human identifier such as ENG-123; leads the seeded prompt and so the workspace name. */
  identifier: string
  title: string
  url: string
  /** Issue body, truncated; seeded into the first prompt when an issue is picked. */
  description: string | null
  stateName: string
  stateType: 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
  teamKey: string
  updatedAt: number
}

/** Linear has no repository to be missing, so its blockers differ from GitHub's. */
export type LinearBlocker =
  | { kind: 'needs-key'; hint: string }
  | { kind: 'invalid-key'; hint: string }
  | { kind: 'failed'; message: string }

export type LinearIssueListResult = { kind: 'ok'; issues: LinearIssueSummary[] } | LinearBlocker

export type ProjectAddInput =
  | { name: string; source: { kind: 'local'; path: string } }
  | { name: string; source: { kind: 'clone'; url: string } }

/** Instruction markdown lives instance-wide or per project, as real files under the data root. */
export type InstructionScope = 'instance' | 'project'

export interface SessionCreateInput {
  workspaceId: string
  backend: BackendId
  model: string
  effort: Effort
  title: string
}

export interface SessionForkInput {
  workspaceId: string
  backend: BackendId
  model: string
  effort: Effort
  sourceSessionId: string
}

/**
 * Single source of truth for request/response IPC. Main registers handlers for
 * these channels; preload exposes typed wrappers; renderer never sees raw ipc.
 */
export interface IpcContract {
  'app:ping': { in: void; out: 'pong' }

  'secrets:has': { in: { provider: BackendId }; out: SecretPresence }
  'secrets:set': { in: { provider: BackendId; value: string }; out: void }
  'secrets:delete': { in: { provider: BackendId }; out: void }

  'providers:status': { in: void; out: Record<BackendId, AuthStatus> }
  'providers:models': { in: { backend: BackendId }; out: ModelDescriptor[] }

  'integrations:status': { in: void; out: IntegrationsStatus }
  'github:prs': { in: { projectId: string; query: string | null }; out: PullRequestListResult }
  'github:workspacePr': { in: { workspaceId: string }; out: WorkspacePrResult }

  'linear:hasKey': { in: void; out: SecretPresence }
  'linear:setKey': { in: { value: string }; out: void }
  'linear:deleteKey': { in: void; out: void }

  'elevenlabs:hasKey': { in: void; out: SecretPresence }
  'elevenlabs:setKey': { in: { value: string }; out: void }
  'elevenlabs:deleteKey': { in: void; out: void }
  'elevenlabs:sttToken': { in: void; out: SttTokenResult }
  'linear:issues': { in: { query: string | null }; out: LinearIssueListResult }

  'shell:openExternal': { in: { url: string }; out: void }

  'projects:list': { in: void; out: ProjectRow[] }
  'projects:add': { in: ProjectAddInput; out: ProjectRow }
  'projects:remove': { in: { id: string; deleteRepo: boolean }; out: void }
  'projects:repoOwned': { in: { id: string }; out: boolean }
  'projects:pickFolder': { in: void; out: string | null }
  'projects:quickstart': { in: { name: string }; out: ProjectRow }
  'projects:clone': { in: { url: string; location: string | null; overwrite: boolean }; out: ProjectRow }
  'projects:setPrompts': { in: ProjectPromptsInput; out: void }

  'instructions:get': { in: { scope: InstructionScope; projectId: string | null }; out: string }
  'instructions:set': {
    in: { scope: InstructionScope; projectId: string | null; text: string }
    out: void
  }

  'workspaces:list': { in: { projectId: string }; out: WorkspaceRow[] }
  'workspaces:add': { in: { projectId: string; name: string; baseRef: string | null }; out: WorkspaceRow }
  'workspaces:remove': { in: { id: string }; out: void }
  'workspaces:setArchived': { in: { id: string; archived: boolean }; out: void }
  'workspaces:scripts': { in: { workspaceId: string }; out: RepoScriptsInfo }
  'workspaces:runAction': { in: { workspaceId: string; actionId: string }; out: string }

  'git:branches': { in: { projectId: string }; out: string[] }
  'git:status': { in: { workspaceId: string }; out: ChangeEntry[] }
  'git:diff': { in: { workspaceId: string; path: string }; out: string }
  'git:checkpoints': { in: { workspaceId: string }; out: CheckpointInfo[] }
  'git:saveCheckpoint': { in: { workspaceId: string; label: string }; out: string }
  'git:restoreCheckpoint': { in: { workspaceId: string; id: string }; out: void }
  'git:diffCheckpoint': { in: { workspaceId: string; id: string }; out: string }

  'sessions:list': { in: { workspaceId: string }; out: SessionRow[] }
  'sessions:create': { in: SessionCreateInput; out: SessionRow }
  'sessions:send': { in: { sessionId: string; text: string; attachments: string[] }; out: void }
  'sessions:sendNow': { in: { sessionId: string; text: string; attachments: string[] }; out: void }
  'sessions:cancel': { in: { sessionId: string }; out: void }
  'sessions:events': { in: { sessionId: string }; out: AgentEvent[] }
  'sessions:exportMarkdown': { in: { sessionId: string }; out: string | null }
  'sessions:fork': { in: SessionForkInput; out: SessionRow }
  'sessions:close': { in: { sessionId: string }; out: void }
  'sessions:closed': { in: { workspaceId: string }; out: SessionRow[] }
  'sessions:reopen': { in: { sessionId: string }; out: SessionRow }
  'sessions:queue': { in: { sessionId: string }; out: string[] }
  'sessions:dequeue': { in: { sessionId: string; index: number }; out: string[] }
  'comments:list': { in: { workspaceId: string }; out: CommentRow[] }
  'comments:add': {
    in: { workspaceId: string; path: string; line: number; body: string }
    out: CommentRow
  }
  'comments:remove': { in: { id: string }; out: void }

  'files:tree': { in: { workspaceId: string }; out: FileNode[] }
  'files:listDir': { in: { workspaceId: string; path: string }; out: FileNode[] }
  'files:read': { in: { workspaceId: string; path: string }; out: { text: string; language: string } }
  'files:pickExternal': { in: void; out: { paths: string[] } }
  'lint:run': { in: { workspaceId: string; path: string; text: string }; out: Diagnostic[] }

  'terminal:create': { in: { workspaceId: string }; out: string }
  'terminal:attach': { in: { workspaceId: string; text: string }; out: string }
  'terminal:write': { in: { id: string; data: string }; out: void }
  'terminal:resize': { in: { id: string; cols: number; rows: number }; out: void }
  'terminal:destroy': { in: { id: string }; out: void }
  'terminal:setActive': { in: { id: string }; out: void }

  'history:search': { in: { query: string; projectId: string | null }; out: HistoryHit[] }

  'env:list': { in: { scope: EnvScope; projectId: string | null }; out: EnvVarRow[] }
  'env:set': { in: { scope: EnvScope; projectId: string | null; name: string; value: string }; out: void }
  'env:delete': { in: { scope: EnvScope; projectId: string | null; name: string }; out: void }
}

const id = z.string().min(1).max(64)
const attachPaths = z.array(z.string().min(1).max(4096)).max(8).default([])

const nullableId = z.string().min(1).max(64).nullable()
const relPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.startsWith('/') && !p.includes('..'), 'path must be workspace-relative')
const checkpointId = z.string().regex(/^cp-\d+-[0-9a-f]{8}$/)
const backend = z.enum(['codex', 'claude', 'gemini', 'qwen'])
const effort = z.enum(EFFORTS)
const envScope = z.enum(['global', 'project'])
const workspaceName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/)

/** Runtime validation for every channel input; TypeScript types do not exist at runtime. */
export const ipcSchemas = {
  'app:ping': z.undefined(),
  'secrets:has': z.object({ provider: backend }),
  'secrets:set': z.object({ provider: backend, value: z.string().min(1).max(4096) }),
  'secrets:delete': z.object({ provider: backend }),
  'providers:status': z.undefined(),
  'providers:models': z.object({ backend }),
  'integrations:status': z.undefined(),
  'github:prs': z.object({ projectId: id, query: z.string().max(200).nullable() }),
  'github:workspacePr': z.object({ workspaceId: id }),
  'linear:hasKey': z.undefined(),
  'linear:setKey': z.object({ value: z.string().min(1).max(4096) }),
  'linear:deleteKey': z.undefined(),
  'elevenlabs:hasKey': z.undefined(),
  'elevenlabs:setKey': z.object({ value: z.string().min(1).max(4096) }),
  'elevenlabs:deleteKey': z.undefined(),
  'elevenlabs:sttToken': z.undefined(),
  'linear:issues': z.object({ query: z.string().max(200).nullable() }),
  'shell:openExternal': z.object({ url: z.string().min(1).max(2048) }),
  'env:list': z.object({ scope: envScope, projectId: nullableId }),
  'env:set': z.object({
    scope: envScope,
    projectId: nullableId,
    name: z.string().min(1).max(128),
    value: z.string().max(65536)
  }),
  'env:delete': z.object({ scope: envScope, projectId: nullableId, name: z.string().min(1).max(128) }),
  'projects:list': z.undefined(),
  'projects:add': z.object({
    name: z.string().min(1).max(64),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('local'), path: z.string().min(1).max(4096) }),
      z.object({ kind: z.literal('clone'), url: z.string().min(1).max(2048) })
    ])
  }) as z.ZodType<ProjectAddInput>,
  'projects:remove': z.object({ id, deleteRepo: z.boolean() }),
  'projects:repoOwned': z.object({ id }),
  'projects:pickFolder': z.undefined(),
  'projects:quickstart': z.object({ name: z.string().min(1).max(64) }),
  'projects:clone': z.object({
    url: z.string().min(1).max(2048),
    location: z.string().max(4096).nullable(),
    overwrite: z.boolean()
  }),
  'projects:setPrompts': z.object({
    projectId: id,
    general: z.string().max(8000).nullable(),
    codeReview: z.string().max(8000).nullable(),
    fixErrors: z.string().max(8000).nullable()
  }),
  'instructions:get': z.object({
    scope: z.enum(['instance', 'project']),
    projectId: z.string().max(64).nullable()
  }),
  'instructions:set': z.object({
    scope: z.enum(['instance', 'project']),
    projectId: z.string().max(64).nullable(),
    text: z.string().max(16_000)
  }),
  'workspaces:list': z.object({ projectId: id }),
  'workspaces:add': z.object({
    projectId: id,
    name: workspaceName,
    baseRef: z.string().min(1).max(200).nullable()
  }),
  'workspaces:remove': z.object({ id }),
  'workspaces:setArchived': z.object({ id, archived: z.boolean() }),
  'workspaces:scripts': z.object({ workspaceId: id }),
  'workspaces:runAction': z.object({ workspaceId: id, actionId: z.string().min(1).max(64) }),

  'git:branches': z.object({ projectId: id }),
  'git:status': z.object({ workspaceId: id }),
  'git:diff': z.object({ workspaceId: id, path: relPath }),
  'git:checkpoints': z.object({ workspaceId: id }),
  'git:saveCheckpoint': z.object({ workspaceId: id, label: z.string().min(1).max(200) }),
  'git:restoreCheckpoint': z.object({ workspaceId: id, id: checkpointId }),
  'git:diffCheckpoint': z.object({ workspaceId: id, id: checkpointId }),
  'sessions:list': z.object({ workspaceId: id }),
  'sessions:create': z.object({
    workspaceId: id,
    backend,
    model: z.string().min(1).max(128),
    effort,
    title: z.string().min(1).max(128)
  }),
  'sessions:send': z.object({ sessionId: id, text: z.string().min(1).max(200000), attachments: attachPaths }),
  'sessions:sendNow': z.object({
    sessionId: id,
    text: z.string().min(1).max(200000),
    attachments: attachPaths
  }),
  'sessions:cancel': z.object({ sessionId: id }),
  'sessions:events': z.object({ sessionId: id }),
  'sessions:exportMarkdown': z.object({ sessionId: id }),
  'sessions:fork': z.object({
    workspaceId: id,
    backend,
    model: z.string().min(1).max(128),
    effort,
    sourceSessionId: id
  }),
  'sessions:close': z.object({ sessionId: id }),
  'sessions:closed': z.object({ workspaceId: id }),
  'sessions:reopen': z.object({ sessionId: id }),
  'sessions:queue': z.object({ sessionId: id }),
  'sessions:dequeue': z.object({ sessionId: id, index: z.number().int().min(0).max(99) }),
  'comments:list': z.object({ workspaceId: id }),
  'comments:add': z.object({
    workspaceId: id,
    path: relPath,
    line: z.number().int().min(1).max(10_000_000),
    body: z.string().min(1).max(4000)
  }),
  'comments:remove': z.object({ id }),
  'files:tree': z.object({ workspaceId: id }),
  'files:listDir': z.object({ workspaceId: id, path: relPath }),
  'files:read': z.object({ workspaceId: id, path: relPath }),
  'files:pickExternal': z.undefined(),
  'lint:run': z.object({ workspaceId: id, path: relPath, text: z.string().max(2000000) }),
  'terminal:create': z.object({ workspaceId: id }),
  'terminal:attach': z.object({ workspaceId: id, text: z.string().min(1).max(200000) }),
  'terminal:write': z.object({ id, data: z.string().max(65536) }),
  'terminal:resize': z.object({
    id,
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(200)
  }),
  'terminal:destroy': z.object({ id }),
  'terminal:setActive': z.object({ id }),
  'history:search': z.object({ query: z.string().max(200), projectId: nullableId })
} satisfies { [K in keyof IpcContract]: z.ZodType<IpcContract[K]['in']> }

export const SESSION_EVENT_CHANNEL = 'session:event'
export interface SessionEventPush {
  sessionId: string
  event: AgentEvent
}

export const TERMINAL_DATA_CHANNEL = 'terminal:data'
export interface TerminalDataPush {
  id: string
  data: string
}

export const TERMINAL_EXIT_CHANNEL = 'terminal:exit'
export interface TerminalExitPush {
  id: string
  code: number
}

export const WORKSPACE_STATE_CHANNEL = 'workspace:state'
export interface WorkspaceStatePush {
  workspaceId: string
  state: WorkspaceState
  /** Present when the display name changed (model naming); the store patches it live. */
  name?: string
}

export const SESSION_QUEUE_CHANNEL = 'session:queue'
export interface SessionQueuePush {
  sessionId: string
  items: string[]
}

export const SESSION_TITLE_CHANNEL = 'session:title'
export interface SessionTitlePush {
  sessionId: string
  title: string
}

/** Where an environment variable lives: every project, or one project overriding global. */
export type EnvScope = 'global' | 'project'

export interface EnvVarRow {
  name: string
  masked: string
}

/** One review comment pinned to a line of a worktree diff (W9). */
export interface CommentRow {
  id: string
  workspaceId: string
  path: string
  line: number
  body: string
  createdAt: number
}

/** The entire surface the renderer may call. Preload implements it; nothing else. */
export interface LoomApi {
  ping(): Promise<'pong'>
  secrets: {
    has(provider: BackendId): Promise<SecretPresence>
    set(provider: BackendId, value: string): Promise<void>
    delete(provider: BackendId): Promise<void>
  }
  providers: {
    status(): Promise<Record<BackendId, AuthStatus>>
    models(backend: BackendId): Promise<ModelDescriptor[]>
  }
  integrations: {
    status(): Promise<IntegrationsStatus>
  }
  github: {
    prs(projectId: string, query?: string | null): Promise<PullRequestListResult>
    workspacePr(workspaceId: string): Promise<WorkspacePrResult>
  }
  linear: {
    hasKey(): Promise<SecretPresence>
    setKey(value: string): Promise<void>
    deleteKey(): Promise<void>
    issues(query?: string | null): Promise<LinearIssueListResult>
  }
  elevenlabs: {
    hasKey(): Promise<SecretPresence>
    setKey(value: string): Promise<void>
    deleteKey(): Promise<void>
    sttToken(): Promise<SttTokenResult>
  }
  env: {
    list(scope: EnvScope, projectId: string | null): Promise<EnvVarRow[]>
    set(scope: EnvScope, projectId: string | null, name: string, value: string): Promise<void>
    delete(scope: EnvScope, projectId: string | null, name: string): Promise<void>
  }
  shell: {
    /** Opens an http(s) URL in the OS default browser; every other scheme is dropped. */
    openExternal(url: string): Promise<void>
  }
  projects: {
    list(): Promise<ProjectRow[]>
    add(input: ProjectAddInput): Promise<ProjectRow>
    remove(id: string, deleteRepo: boolean): Promise<void>
    /** True when Loom cloned or created the repository itself (it lives under the repos dir). */
    repoOwned(id: string): Promise<boolean>
    pickFolder(): Promise<string | null>
    quickstart(name: string): Promise<ProjectRow>
    clone(url: string, location: string | null, overwrite: boolean): Promise<ProjectRow>
    setPrompts(input: ProjectPromptsInput): Promise<void>
  }
  instructions: {
    get(scope: InstructionScope, projectId: string | null): Promise<string>
    set(scope: InstructionScope, projectId: string | null, text: string): Promise<void>
  }
  workspaces: {
    list(projectId: string): Promise<WorkspaceRow[]>
    add(projectId: string, name: string, baseRef?: string | null): Promise<WorkspaceRow>
    remove(id: string): Promise<void>
    setArchived(id: string, archived: boolean): Promise<void>
    scripts(workspaceId: string): Promise<RepoScriptsInfo>
    runAction(workspaceId: string, actionId: string): Promise<string>
  }
  git: {
    branches(projectId: string): Promise<string[]>
    status(workspaceId: string): Promise<ChangeEntry[]>
    diff(workspaceId: string, path: string): Promise<string>
    checkpoints(workspaceId: string): Promise<CheckpointInfo[]>
    saveCheckpoint(workspaceId: string, label: string): Promise<string>
    restoreCheckpoint(workspaceId: string, id: string): Promise<void>
    diffCheckpoint(workspaceId: string, id: string): Promise<string>
  }
  sessions: {
    list(workspaceId: string): Promise<SessionRow[]>
    create(input: SessionCreateInput): Promise<SessionRow>
    send(sessionId: string, text: string, attachments?: string[]): Promise<void>
    sendNow(sessionId: string, text: string, attachments?: string[]): Promise<void>
    cancel(sessionId: string): Promise<void>
    events(sessionId: string): Promise<AgentEvent[]>
    exportMarkdown(sessionId: string): Promise<string | null>
    fork(input: SessionForkInput): Promise<SessionRow>
    close(sessionId: string): Promise<void>
    closed(workspaceId: string): Promise<SessionRow[]>
    reopen(sessionId: string): Promise<SessionRow>
    queue(sessionId: string): Promise<string[]>
    dequeue(sessionId: string, index: number): Promise<string[]>
  }
  comments: {
    list(workspaceId: string): Promise<CommentRow[]>
    add(input: { workspaceId: string; path: string; line: number; body: string }): Promise<CommentRow>
    remove(id: string): Promise<void>
  }
  files: {
    tree(workspaceId: string): Promise<FileNode[]>
    listDir(workspaceId: string, path: string): Promise<FileNode[]>
    read(workspaceId: string, path: string): Promise<{ text: string; language: string }>
    /** Native open dialog for attaching files outside the worktree; main still vets every path. */
    pickExternal(): Promise<{ paths: string[] }>
  }
  lint: {
    run(workspaceId: string, path: string, text: string): Promise<Diagnostic[]>
  }
  terminal: {
    create(workspaceId: string): Promise<string>
    attach(workspaceId: string, text: string): Promise<string>
    write(id: string, data: string): Promise<void>
    resize(id: string, cols: number, rows: number): Promise<void>
    destroy(id: string): Promise<void>
    /** Tells main which terminal the user is looking at, so run actions target it. */
    setActive(id: string): Promise<void>
  }
  history: {
    search(query: string, projectId: string | null): Promise<HistoryHit[]>
  }
  onSessionEvent(cb: (push: SessionEventPush) => void): () => void
  onTerminalData(cb: (push: TerminalDataPush) => void): () => void
  onTerminalExit(cb: (push: TerminalExitPush) => void): () => void
  onWorkspaceState(cb: (push: WorkspaceStatePush) => void): () => void
  onSessionQueue(cb: (push: SessionQueuePush) => void): () => void
  onSessionTitle(cb: (push: SessionTitlePush) => void): () => void
}

declare global {
  interface Window {
    loom: LoomApi
  }
}
