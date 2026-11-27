import { z } from 'zod'
import { questionAnswer, type AgentEvent, type QuestionAnswer } from './events'
import { MAX_ATTACHMENTS, MAX_INSTANCE_INSTRUCTION_CHARS, MAX_PROJECT_INSTRUCTION_CHARS } from './limits'
import { CLAUDE_MODES, CODEX_MODES, EFFORTS } from './models'
import type { AgentModes, AuthStatus, BackendId, Effort, ModelDescriptor } from './models'
import type { Notification } from './notifications'
import type { DesktopUpdateStatus } from './desktop-updates'
import type { OrgAdminEvent, OrgInvite, OrgMember, OrgOverview, OrgRole } from './org'
import type { CloudSignInMode } from './managed-cloud'
import {
  botAccessSchema,
  botConfigSchema,
  botSlugSchema,
  type BotAccess,
  type BotConfig,
  type BotGrant,
  type BotInvocation,
  type BotRecord
} from './bots'
import {
  subscriptionLabelSchema,
  subscriptionProviderSchema,
  subscriptionUpdateSchema,
  type SubscriptionAccess,
  type SubscriptionAccount,
  type SubscriptionProvider
} from './subscriptions'

export const BOTS_CHANGED_CHANNEL = 'bots:changed'
export interface BotChangedPush {
  botId: string
  /** Metadata-only updates retain existing previews and cached workspace routing. */
  accessChanged: boolean
}

export interface BotWorkspace {
  invocation: BotInvocation
  project: ProjectRow | null
  workspace: WorkspaceRow | null
  session: SessionRow | null
}

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
  checkout: WorkspaceCheckout
  runtime: WorkspaceRuntimeKind
  /** The user a workspace on a runner belongs to; null on this Mac, where there is one user. */
  ownerId: string | null
  /** Set by the desktop on a workspace a runner owns; absent on one that lives on this Mac. */
  cloud?: true
  /** Explicit permissions for a shared bot workspace; omitted for personal workspaces. */
  bot?: { id: string; access: BotAccess }
}

/** How a workspace holds its files: a worktree of the project repository, or a self-contained clone. */
export type WorkspaceCheckout = 'worktree' | 'clone'

/** Where a workspace's agents, terminals and setup script run. A container needs a clone checkout. */
export type WorkspaceRuntimeKind = 'machine' | 'container'

/** Container power is independent of whether its checkout and setup succeeded. */
export interface WorkspacePower {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  error: string | null
}

export interface WorkspacePowerPush extends WorkspacePower {
  workspaceId: string
}

export interface PortForward {
  port: number
  localPort: number
}

export interface CloudHealth {
  disk: { total: number; available: number; warning: boolean }
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

export interface SessionActivity {
  revision: number
  bySession: Record<string, string>
}

export interface SessionUnread {
  workspaceId: string
  /** Globally increasing event id, used to order unread replies across sessions. */
  eventId: number
  /** Latest unread assistant text event; zero is a renderer acknowledgment tombstone. */
  seq: number
}

/** Loom's saved instruction text; provider-managed discovery is not inspected. */
export interface SessionInstructionsInfo {
  status: 'pending' | 'saved' | 'legacy'
  text: string | null
  repositoryMode: 'native' | 'root-files'
}

/** The runner this desktop follows, as Settings shows it. */
export interface CloudRunner {
  mode?: CloudSignInMode
  /** ws:// or wss:// address; null when Loom follows no runner. */
  url: string | null
  /** The address comes from LOOM_RUNNER_URL, so Settings cannot change it. */
  fixed: boolean
  /** A developer's token from the environment stands in for signing in. */
  devToken: boolean
  /** Destination history, scoped to this host; it is not proof of a current sign-in. */
  lastSignIn?: { email?: string; organizationName?: string }
}

/** Which of a person's agent logins the runner keeps for their cloud workspaces. */
export interface AgentLogins {
  /** False where the runner leaves logins in the home folder, as a developer's own runner does. */
  managed: boolean
  claude: boolean
  codex: boolean
  /** A token for git and gh in cloud workspaces. */
  github: boolean
  /** A Codex sign-in is waiting for the person to finish in their browser. */
  codexSigningIn: boolean
  attempts?: Partial<Record<'codex' | 'github', LoginAttempt>>
  githubApp?: {
    configured: boolean
    account: string | null
    installed: boolean
    installUrl: string | null
  }
}

export interface LoginAttempt {
  id: string
  state: 'starting' | 'waiting' | 'connected' | 'failed' | 'expired'
  expiresAt: number
  url?: string
  code?: string
  message?: string
}

/** What to do to finish a Codex sign-in: the page to open and the code to enter there. */
export interface CodexSignIn {
  url: string
  code: string
}

export type AgentLoginProvider = 'claude' | 'codex' | 'github'

/** Whether this desktop is following a runner, and how that is going. */
export type CloudStatus =
  | { state: 'off' }
  | { state: 'connecting' }
  | { state: 'connected'; capabilities?: readonly string[] }
  | { state: 'unreachable' }
  /** The runner is there, but this desktop has no sign-in it accepts. */
  | { state: 'signed-out' }
  /** The desktop and the runner are different versions; one of them has to be updated. */
  | { state: 'update'; message: string }

export interface TerminalInfo {
  id: string
  /** The most recent output, when the terminal's owner keeps it; otherwise empty. */
  scrollback: string
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

export type FilePreview =
  { kind: 'text'; text: string; language: string } | { kind: 'image'; mimeType: string; dataUrl: string }

export interface SecretPresence {
  present: boolean
  masked: string | null
}

/** Single-use ElevenLabs websocket token minted in main; the long-lived key never crosses. */
export type SingleUseTokenResult =
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

/** What the sidebar badges a workspace with; closed-unmerged PRs and no PR show the plain branch. */
export type BranchPrState = 'open' | 'merged'

/** Keyed by head branch name. */
export type BranchPrsResult =
  | {
      kind: 'ok'
      byBranch: Record<string, BranchPrState>
      byWorkspace?: Record<string, BranchPrState | null>
    }
  | IntegrationBlocker

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
export type WorkspaceRelatedPr = PullRequestSummary & { sessionIds: string[] }
export type WorkspacePrResult =
  | {
      kind: 'ok'
      pullRequest: PullRequestDetail | null
      pullRequests?: WorkspaceRelatedPr[]
      state?: BranchPrState | null
    }
  | IntegrationBlocker

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
  'github:prs': {
    in: { projectId: string; query: string | null; cloud?: boolean | undefined }
    out: PullRequestListResult
  }
  'github:workspacePr': { in: { workspaceId: string; refresh?: boolean | undefined }; out: WorkspacePrResult }
  'github:branchPrs': { in: { projectId: string; cloud?: boolean | undefined }; out: BranchPrsResult }

  'linear:hasKey': { in: void; out: SecretPresence }
  'linear:setKey': { in: { value: string }; out: void }
  'linear:deleteKey': { in: void; out: void }

  'elevenlabs:hasKey': { in: void; out: SecretPresence }
  'elevenlabs:setKey': { in: { value: string }; out: void }
  'elevenlabs:deleteKey': { in: void; out: void }
  'elevenlabs:sttToken': { in: void; out: SingleUseTokenResult }
  'elevenlabs:ttsToken': { in: void; out: SingleUseTokenResult }
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
  'workspaces:power': { in: { workspaceId: string }; out: WorkspacePower }
  'workspaces:start': { in: { workspaceId: string }; out: WorkspacePower }
  'workspaces:stop': { in: { workspaceId: string }; out: WorkspacePower }
  'ports:list': { in: { workspaceId: string }; out: PortForward[] }
  'ports:forward': {
    in: { workspaceId: string; port: number; localPort?: number | undefined }
    out: PortForward
  }
  'ports:unforward': { in: { workspaceId: string; port: number }; out: void }
  'cloud:health': { in: void; out: CloudHealth | null }
  'workspaces:add': {
    /** `modes` is stamped on a cloud workspace; a workspace on this Mac takes none. */
    in: {
      projectId: string
      name: string
      baseRef: string | null
      cloud: boolean
      modes?: AgentModes | undefined
    }
    out: WorkspaceRow
  }
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
  'sessions:activity': { in: void; out: SessionActivity }
  'sessions:unread': { in: void; out: Record<string, SessionUnread> }
  'sessions:markRead': { in: { sessionId: string; seq: number }; out: void }
  'sessions:create': { in: SessionCreateInput; out: SessionRow }
  'sessions:send': { in: { sessionId: string; text: string; attachments: string[] }; out: void }
  'sessions:steer': { in: { sessionId: string; text: string; attachments: string[] }; out: void }
  'sessions:steerQueued': { in: { sessionId: string; messageId: string }; out: QueuedMessage[] }
  'sessions:answerQuestion': { in: { sessionId: string; answer: QuestionAnswer }; out: void }
  'sessions:sendNow': { in: { sessionId: string; text: string; attachments: string[] }; out: void }
  'sessions:cancel': { in: { sessionId: string }; out: void }
  'sessions:events': { in: { sessionId: string }; out: AgentEvent[] }
  'sessions:eventsAfter': { in: { sessionId: string; afterSeq: number }; out: SequencedEvent[] }
  'sessions:instructions': { in: { sessionId: string }; out: SessionInstructionsInfo }
  'sessions:exportMarkdown': { in: { sessionId: string }; out: string | null }
  'sessions:fork': { in: SessionForkInput; out: SessionRow }
  'sessions:close': { in: { sessionId: string }; out: void }
  'sessions:closed': { in: { workspaceId: string }; out: SessionRow[] }
  'sessions:reopen': { in: { sessionId: string }; out: SessionRow }
  'sessions:queue': { in: { sessionId: string }; out: QueuedMessage[] }
  'sessions:dequeue': { in: { sessionId: string; index: number }; out: QueuedMessage[] }
  'comments:list': { in: { workspaceId: string }; out: CommentRow[] }
  'comments:add': {
    in: { workspaceId: string; path: string; line: number; body: string }
    out: CommentRow
  }
  'comments:remove': { in: { id: string }; out: void }

  'files:tree': { in: { workspaceId: string }; out: FileNode[] }
  'files:listDir': { in: { workspaceId: string; path: string }; out: FileNode[] }
  'files:read': { in: { workspaceId: string; path: string }; out: { text: string; language: string } }
  'files:preview': { in: { workspaceId: string; path: string }; out: FilePreview }
  'files:reveal': { in: { workspaceId: string; path: string }; out: void }
  'files:pickExternal': { in: void; out: { paths: string[] } }
  'lint:run': { in: { workspaceId: string; path: string; text: string }; out: Diagnostic[] }

  'terminal:create': { in: { workspaceId: string }; out: string }
  'terminal:list': { in: { workspaceId: string }; out: TerminalInfo[] }
  'terminal:attach': { in: { workspaceId: string; text: string }; out: string }
  'terminal:write': { in: { id: string; data: string }; out: void }
  'terminal:resize': { in: { id: string; cols: number; rows: number }; out: void }
  'terminal:destroy': { in: { id: string }; out: void }
  'terminal:setActive': { in: { id: string }; out: void }

  'history:search': { in: { query: string; projectId: string | null }; out: HistoryHit[] }

  /** The caller's own notifications, newest first. */
  'notifications:list': { in: void; out: Notification[] }
  /** Marks all of the caller's notifications read. */
  'notifications:read': { in: void; out: void }
  /** Answers with the notification as the answer left it. */
  'notifications:answer': { in: { id: string; answer: string }; out: Notification }

  'updates:status': { in: void; out: DesktopUpdateStatus }
  'updates:check': { in: void; out: void }
  'updates:download': { in: void; out: void }
  'updates:install': { in: void; out: void }

  'cloud:status': { in: void; out: CloudStatus }
  'cloud:runner': { in: void; out: CloudRunner }
  'cloud:setRunner': {
    in: { url: string | null; expectedEmail: string; mode?: CloudSignInMode | undefined }
    out: CloudRunner
  }
  /** Answers once the person has finished in the browser, which can take minutes. */
  'cloud:signIn': { in: { expectedEmail: string }; out: void }
  'cloud:signOut': { in: void; out: void }
  'cloud:cancelSignIn': { in: void; out: void }
  'cloud:reconnect': { in: void; out: void }
  'cloud:previewInvite': { in: { code: string }; out: { host: string } }
  'cloud:join': { in: { code: string; expectedEmail: string }; out: CloudRunner }

  'org:get': { in: void; out: OrgOverview | null }
  'org:update': { in: { name: string }; out: void }
  'org:members': { in: void; out: OrgMember[] }
  'org:invite': { in: { email: string }; out: { invite: OrgInvite; code: string } }
  'org:invites': { in: void; out: OrgInvite[] }
  'org:revokeInvite': { in: { id: string }; out: void }
  'org:setRole': { in: { userId: string; role: OrgRole }; out: void }
  'org:removeMember': { in: { userId: string }; out: void }
  'org:purgeMember': { in: { userId: string }; out: void }
  'org:log': { in: { before?: number | undefined }; out: OrgAdminEvent[] }
  'bots:list': { in: void; out: BotRecord[] }
  'bots:create': { in: { slug: string; config: BotConfig }; out: BotRecord }
  'bots:update': {
    in: { botId: string; config: BotConfig; enabled: boolean; revision: number }
    out: BotRecord
  }
  'bots:grants': { in: { botId: string }; out: BotGrant[] }
  'bots:setGrant': { in: { botId: string; userId: string; access: BotAccess | null }; out: void }
  'bots:logins': { in: { botId: string }; out: AgentLogins }
  'bots:connectClaude': { in: { botId: string; token: string }; out: void }
  'bots:connectCodex': { in: { botId: string }; out: CodexSignIn }
  'bots:setGithub': {
    in: { botId: string; appId: string; installationId: string; privateKey: string }
    out: void
  }
  'bots:disconnect': { in: { botId: string; provider: AgentLoginProvider }; out: void }
  'bots:invoke': {
    in: { botId: string; repository: string; prompt: string; requestKey: string }
    out: BotInvocation
  }
  'bots:invocations': { in: { botId: string }; out: BotInvocation[] }
  'bots:open': { in: { invocationId: string }; out: BotWorkspace }
  'subscriptions:list': { in: void; out: SubscriptionAccount[] }
  'subscriptions:create': { in: { provider: SubscriptionProvider; label: string }; out: SubscriptionAccount }
  'subscriptions:update': {
    in: { accountId: string; label: string; enabled: boolean; expectedEnabled: boolean }
    out: SubscriptionAccount
  }
  'subscriptions:connectClaude': { in: { accountId: string; token: string }; out: void }
  'subscriptions:connectCodex': { in: { accountId: string }; out: CodexSignIn }
  'subscriptions:status': { in: { accountId: string }; out: AgentLogins }
  'subscriptions:disconnect': { in: { accountId: string }; out: void }
  'subscriptions:grants': { in: { botId: string }; out: SubscriptionAccess }
  'subscriptions:setGrant': {
    in: { botId: string; provider: SubscriptionProvider; allowed: boolean }
    out: void
  }
  'logins:status': { in: void; out: AgentLogins }
  /** The token `claude setup-token` printed. It goes to the runner's vault and nowhere else. */
  'logins:connectClaude': { in: { token: string }; out: void }
  /** Opens the runner's GitHub App authorization flow. */
  'logins:connectGithub': { in: void; out: { url: string } }
  'logins:checkGithub': { in: void; out: void }
  /** Starts a Codex sign-in on the runner, away from every workspace; an earlier one is abandoned. */
  'logins:connectCodex': { in: void; out: CodexSignIn }
  'logins:disconnect': { in: { provider: AgentLoginProvider }; out: void }

  /** `cloud` means the values kept on the runner for cloud workspaces, not this Mac's. */
  'env:list': { in: { scope: EnvScope; projectId: string | null; cloud: boolean }; out: EnvVarRow[] }
  'env:set': {
    in: { scope: EnvScope; projectId: string | null; name: string; value: string; cloud: boolean }
    out: void
  }
  'env:delete': { in: { scope: EnvScope; projectId: string | null; name: string; cloud: boolean }; out: void }
}

const id = z.string().min(1).max(64)
const attachPaths = z.array(z.string().min(1).max(4096)).max(MAX_ATTACHMENTS).default([])
const promptInput = z
  .object({ sessionId: id, text: z.string().max(200000), attachments: attachPaths })
  .refine(
    (input) => input.text.trim().length > 0 || input.attachments.length > 0,
    'Add a message or an attachment'
  )

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
  'github:prs': z.object({
    projectId: id,
    query: z.string().max(200).nullable(),
    cloud: z.boolean().optional()
  }),
  'github:workspacePr': z.object({ workspaceId: id, refresh: z.boolean().optional() }),
  'github:branchPrs': z.object({ projectId: id, cloud: z.boolean().optional() }),
  'linear:hasKey': z.undefined(),
  'linear:setKey': z.object({ value: z.string().min(1).max(4096) }),
  'linear:deleteKey': z.undefined(),
  'elevenlabs:hasKey': z.undefined(),
  'elevenlabs:setKey': z.object({ value: z.string().min(1).max(4096) }),
  'elevenlabs:deleteKey': z.undefined(),
  'elevenlabs:sttToken': z.undefined(),
  'elevenlabs:ttsToken': z.undefined(),
  'linear:issues': z.object({ query: z.string().max(200).nullable() }),
  'shell:openExternal': z.object({ url: z.string().min(1).max(2048) }),
  'env:list': z.object({ scope: envScope, projectId: nullableId, cloud: z.boolean().default(false) }),
  'env:set': z.object({
    scope: envScope,
    projectId: nullableId,
    name: z.string().min(1).max(128),
    value: z.string().max(65536),
    cloud: z.boolean().default(false)
  }),
  'env:delete': z.object({
    scope: envScope,
    projectId: nullableId,
    name: z.string().min(1).max(128),
    cloud: z.boolean().default(false)
  }),
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
  'instructions:set': z
    .object({
      scope: z.enum(['instance', 'project']),
      projectId: z.string().max(64).nullable(),
      text: z.string().max(MAX_PROJECT_INSTRUCTION_CHARS)
    })
    .refine(({ scope, text }) => scope === 'project' || text.length <= MAX_INSTANCE_INSTRUCTION_CHARS, {
      message: `Instance instructions must be at most ${MAX_INSTANCE_INSTRUCTION_CHARS} characters`,
      path: ['text']
    }),
  'workspaces:list': z.object({ projectId: id }),
  'workspaces:power': z.object({ workspaceId: id }),
  'workspaces:start': z.object({ workspaceId: id }),
  'workspaces:stop': z.object({ workspaceId: id }),
  'ports:list': z.object({ workspaceId: id }),
  'ports:forward': z.object({
    workspaceId: id,
    port: z.number().int().min(1024).max(65535),
    localPort: z.number().int().min(0).max(65535).optional()
  }),
  'ports:unforward': z.object({ workspaceId: id, port: z.number().int().min(1024).max(65535) }),
  'cloud:health': z.undefined(),
  'workspaces:add': z.object({
    projectId: id,
    name: workspaceName,
    baseRef: z.string().min(1).max(200).nullable(),
    cloud: z.boolean().default(false),
    modes: z.object({ claude: z.enum(CLAUDE_MODES), codex: z.enum(CODEX_MODES) }).optional()
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
  'sessions:send': promptInput,
  'sessions:steer': promptInput,
  'sessions:steerQueued': z.object({ sessionId: id, messageId: id }),
  'sessions:answerQuestion': z.object({ sessionId: id, answer: questionAnswer }),
  'sessions:sendNow': promptInput,
  'sessions:cancel': z.object({ sessionId: id }),
  'sessions:events': z.object({ sessionId: id }),
  'sessions:eventsAfter': z.object({ sessionId: id, afterSeq: z.number().int().min(0) }),
  'sessions:instructions': z.object({ sessionId: id }),
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
  'sessions:activity': z.undefined(),
  'sessions:unread': z.undefined(),
  'sessions:markRead': z.object({ sessionId: id, seq: z.number().int().min(0) }),
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
  'files:preview': z.object({ workspaceId: id, path: relPath }),
  'files:reveal': z.object({ workspaceId: id, path: relPath }),
  'files:pickExternal': z.undefined(),
  'lint:run': z.object({ workspaceId: id, path: relPath, text: z.string().max(2000000) }),
  'terminal:create': z.object({ workspaceId: id }),
  'terminal:list': z.object({ workspaceId: id }),
  'terminal:attach': z.object({ workspaceId: id, text: z.string().min(1).max(200000) }),
  'terminal:write': z.object({ id, data: z.string().max(65536) }),
  'terminal:resize': z.object({
    id,
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(200)
  }),
  'terminal:destroy': z.object({ id }),
  'terminal:setActive': z.object({ id }),
  'history:search': z.object({ query: z.string().max(200), projectId: nullableId }),
  'notifications:list': z.undefined(),
  'notifications:read': z.undefined(),
  'notifications:answer': z.object({ id, answer: z.string().min(1).max(32) }),
  'updates:status': z.undefined(),
  'updates:check': z.undefined(),
  'updates:download': z.undefined(),
  'updates:install': z.undefined(),
  'cloud:status': z.undefined(),
  'cloud:runner': z.undefined(),
  'cloud:setRunner': z.object({
    mode: z.enum(['company', 'managed']).optional(),
    url: z.string().max(2048).nullable(),
    expectedEmail: z.string().trim().max(254).default('')
  }),
  'cloud:signIn': z.object({ expectedEmail: z.string().trim().max(254).default('') }),
  'cloud:signOut': z.undefined(),
  'cloud:cancelSignIn': z.undefined(),
  'cloud:reconnect': z.undefined(),
  'cloud:previewInvite': z.object({ code: z.string().min(1).max(4096) }),
  'cloud:join': z.object({
    code: z.string().min(1).max(4096),
    expectedEmail: z.string().trim().max(254).default('')
  }),
  'org:get': z.undefined(),
  'org:update': z.object({ name: z.string().trim().min(1).max(100) }),
  'org:members': z.undefined(),
  'org:invite': z.object({ email: z.email().max(254) }),
  'org:invites': z.undefined(),
  'org:revokeInvite': z.object({ id }),
  'org:setRole': z.object({ userId: id, role: z.enum(['owner', 'member']) }),
  'org:removeMember': z.object({ userId: id }),
  'org:purgeMember': z.object({ userId: id }),
  'org:log': z.object({ before: z.number().int().positive().optional() }),
  'bots:list': z.undefined(),
  'bots:create': z.object({ slug: botSlugSchema, config: botConfigSchema }).strict(),
  'bots:update': z
    .object({
      botId: id,
      config: botConfigSchema,
      enabled: z.boolean(),
      revision: z.number().int().positive()
    })
    .strict(),
  'bots:grants': z.object({ botId: id }).strict(),
  'bots:setGrant': z.object({ botId: id, userId: id, access: botAccessSchema.nullable() }).strict(),
  'bots:logins': z.object({ botId: id }).strict(),
  'bots:connectClaude': z.object({ botId: id, token: z.string().min(1).max(8192) }).strict(),
  'bots:connectCodex': z.object({ botId: id }).strict(),
  'bots:setGithub': z
    .object({
      botId: id,
      appId: z.string().regex(/^[1-9]\d{0,19}$/),
      installationId: z.string().regex(/^[1-9]\d{0,19}$/),
      privateKey: z.string().min(1).max(32768)
    })
    .strict(),
  'bots:disconnect': z.object({ botId: id, provider: z.enum(['claude', 'codex', 'github']) }).strict(),
  'bots:invoke': z
    .object({
      botId: id,
      repository: z.string().min(1).max(512),
      prompt: z.string().trim().min(1).max(32000),
      requestKey: z.string().min(1).max(128)
    })
    .strict(),
  'bots:invocations': z.object({ botId: id }).strict(),
  'bots:open': z.object({ invocationId: id }).strict(),
  'subscriptions:list': z.undefined(),
  'subscriptions:create': z
    .object({ provider: subscriptionProviderSchema, label: subscriptionLabelSchema })
    .strict(),
  'subscriptions:update': subscriptionUpdateSchema.extend({ accountId: id, expectedEnabled: z.boolean() }),
  'subscriptions:connectClaude': z.object({ accountId: id, token: z.string().min(1).max(8192) }).strict(),
  'subscriptions:connectCodex': z.object({ accountId: id }).strict(),
  'subscriptions:status': z.object({ accountId: id }).strict(),
  'subscriptions:disconnect': z.object({ accountId: id }).strict(),
  'subscriptions:grants': z.object({ botId: id }).strict(),
  'subscriptions:setGrant': z
    .object({ botId: id, provider: subscriptionProviderSchema, allowed: z.boolean() })
    .strict(),
  'logins:status': z.undefined(),
  'logins:connectClaude': z.object({ token: z.string().min(1).max(4096) }),
  'logins:connectCodex': z.undefined(),
  'logins:connectGithub': z.undefined(),
  'logins:checkGithub': z.undefined(),
  'logins:disconnect': z.object({ provider: z.enum(['claude', 'codex', 'github']) })
} satisfies { [K in keyof IpcContract]: z.ZodType<IpcContract[K]['in']> }

export const SESSION_EVENT_CHANNEL = 'session:event'
export const SESSION_ACTIVITY_CHANNEL = 'session:activity'
export interface SessionEventPush {
  /** Runner attachment allows access revocation to fence even previously unknown sessions. */
  workspaceId?: string
  sessionId: string
  event: AgentEvent
  unread?: SessionUnread
}

/**
 * A pushed event with its number within its tab (from 1, no gaps). The window ignores the
 * number; a desktop following a runner uses it to notice and fill what a dropped
 * connection cost it.
 */
export interface NumberedSessionEventPush extends SessionEventPush {
  seq: number
}

/** One stored event with its number, for asking "what came after the last one I have?". */
export interface SequencedEvent {
  seq: number
  event: AgentEvent
}

export const CLOUD_STATUS_CHANNEL = 'cloud:status'
export const WORKSPACE_POWER_CHANNEL = 'workspaces:powerChanged'

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
export interface QueuedMessage {
  id: string
  text: string
}
export interface SessionQueuePush {
  sessionId: string
  items: QueuedMessage[]
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
    prs(projectId: string, query?: string | null, cloud?: boolean): Promise<PullRequestListResult>
    workspacePr(workspaceId: string, refresh?: boolean): Promise<WorkspacePrResult>
    branchPrs(projectId: string, cloud?: boolean): Promise<BranchPrsResult>
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
    sttToken(): Promise<SingleUseTokenResult>
    ttsToken(): Promise<SingleUseTokenResult>
  }
  env: {
    /** `cloud` selects the values kept on the runner for cloud workspaces. */
    list(scope: EnvScope, projectId: string | null, cloud?: boolean): Promise<EnvVarRow[]>
    set(
      scope: EnvScope,
      projectId: string | null,
      name: string,
      value: string,
      cloud?: boolean
    ): Promise<void>
    delete(scope: EnvScope, projectId: string | null, name: string, cloud?: boolean): Promise<void>
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
    power(workspaceId: string): Promise<WorkspacePower>
    start(workspaceId: string): Promise<WorkspacePower>
    stop(workspaceId: string): Promise<WorkspacePower>
    list(projectId: string): Promise<WorkspaceRow[]>
    /** `cloud` creates the workspace on the runner this desktop follows, stamped with `modes`. */
    add(
      projectId: string,
      name: string,
      baseRef?: string | null,
      cloud?: boolean,
      modes?: AgentModes
    ): Promise<WorkspaceRow>
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
    activity(): Promise<SessionActivity>
    unread(): Promise<Record<string, SessionUnread>>
    markRead(sessionId: string, seq: number): Promise<void>
    list(workspaceId: string): Promise<SessionRow[]>
    create(input: SessionCreateInput): Promise<SessionRow>
    send(sessionId: string, text: string, attachments?: string[]): Promise<void>
    steer(sessionId: string, text: string, attachments?: string[]): Promise<void>
    steerQueued(sessionId: string, messageId: string): Promise<QueuedMessage[]>
    answerQuestion(sessionId: string, answer: QuestionAnswer): Promise<void>
    sendNow(sessionId: string, text: string, attachments?: string[]): Promise<void>
    cancel(sessionId: string): Promise<void>
    events(sessionId: string): Promise<AgentEvent[]>
    /** A tab's events numbered above `afterSeq`; 0 asks for all of them. */
    eventsAfter(sessionId: string, afterSeq: number): Promise<SequencedEvent[]>
    instructions(sessionId: string): Promise<SessionInstructionsInfo>
    exportMarkdown(sessionId: string): Promise<string | null>
    fork(input: SessionForkInput): Promise<SessionRow>
    close(sessionId: string): Promise<void>
    closed(workspaceId: string): Promise<SessionRow[]>
    reopen(sessionId: string): Promise<SessionRow>
    queue(sessionId: string): Promise<QueuedMessage[]>
    dequeue(sessionId: string, index: number): Promise<QueuedMessage[]>
  }
  comments: {
    list(workspaceId: string): Promise<CommentRow[]>
    add(input: { workspaceId: string; path: string; line: number; body: string }): Promise<CommentRow>
    remove(id: string): Promise<void>
  }
  files: {
    /** Local preload operation; DOM File objects never cross main-process IPC. */
    pathsForFiles(files: File[]): string[]
    tree(workspaceId: string): Promise<FileNode[]>
    listDir(workspaceId: string, path: string): Promise<FileNode[]>
    read(workspaceId: string, path: string): Promise<{ text: string; language: string }>
    preview(workspaceId: string, path: string): Promise<FilePreview>
    reveal(workspaceId: string, path: string): Promise<void>
    /** Native open dialog for attaching files outside the worktree; main still vets every path. */
    pickExternal(): Promise<{ paths: string[] }>
  }
  lint: {
    run(workspaceId: string, path: string, text: string): Promise<Diagnostic[]>
  }
  terminal: {
    create(workspaceId: string): Promise<string>
    /** Terminals of the workspace that are already running, for a desktop that reconnects. */
    list(workspaceId: string): Promise<TerminalInfo[]>
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
  notifications: {
    list(): Promise<Notification[]>
    read(): Promise<void>
    answer(id: string, answer: string): Promise<Notification>
  }
  updates: {
    status(): Promise<DesktopUpdateStatus>
    check(): Promise<void>
    download(): Promise<void>
    install(): Promise<void>
  }
  onUpdateStatus(cb: (status: DesktopUpdateStatus) => void): () => void
  cloud: {
    health(): Promise<CloudHealth | null>
    status(): Promise<CloudStatus>
    runner(): Promise<CloudRunner>
    /** Null stops following a runner. Answers with the address as it was kept. */
    setRunner(url: string | null, expectedEmail?: string, mode?: CloudSignInMode): Promise<CloudRunner>
    /** Opens the sign-in page in the browser; calling again abandons the earlier attempt. */
    signIn(expectedEmail?: string): Promise<void>
    signOut(): Promise<void>
    cancelSignIn(): Promise<void>
    reconnect(): Promise<void>
    previewInvite(code: string): Promise<{ host: string }>
    join(code: string, expectedEmail?: string): Promise<CloudRunner>
  }
  org: {
    get(): Promise<OrgOverview | null>
    update(name: string): Promise<void>
    members(): Promise<OrgMember[]>
    invite(email: string): Promise<{ invite: OrgInvite; code: string }>
    invites(): Promise<OrgInvite[]>
    revokeInvite(id: string): Promise<void>
    setRole(userId: string, role: OrgRole): Promise<void>
    removeMember(userId: string): Promise<void>
    purgeMember(userId: string): Promise<void>
    log(before?: number): Promise<OrgAdminEvent[]>
  }
  bots: {
    list(): Promise<BotRecord[]>
    create(slug: string, config: BotConfig): Promise<BotRecord>
    update(botId: string, config: BotConfig, enabled: boolean, revision: number): Promise<BotRecord>
    grants(botId: string): Promise<BotGrant[]>
    setGrant(botId: string, userId: string, access: BotAccess | null): Promise<void>
    logins(botId: string): Promise<AgentLogins>
    connectClaude(botId: string, token: string): Promise<void>
    connectCodex(botId: string): Promise<CodexSignIn>
    setGithub(
      botId: string,
      credentials: { appId: string; installationId: string; privateKey: string }
    ): Promise<void>
    disconnect(botId: string, provider: AgentLoginProvider): Promise<void>
    invoke(botId: string, repository: string, prompt: string, requestKey: string): Promise<BotInvocation>
    invocations(botId: string): Promise<BotInvocation[]>
    open(invocationId: string): Promise<BotWorkspace>
  }
  onBotsChanged(cb: (push: BotChangedPush) => void): () => void
  subscriptions: {
    list(): Promise<SubscriptionAccount[]>
    create(provider: SubscriptionProvider, label: string): Promise<SubscriptionAccount>
    update(
      accountId: string,
      label: string,
      enabled: boolean,
      expectedEnabled: boolean
    ): Promise<SubscriptionAccount>
    connectClaude(accountId: string, token: string): Promise<void>
    connectCodex(accountId: string): Promise<CodexSignIn>
    status(accountId: string): Promise<AgentLogins>
    disconnect(accountId: string): Promise<void>
    grants(botId: string): Promise<SubscriptionAccess>
    setGrant(botId: string, provider: SubscriptionProvider, allowed: boolean): Promise<void>
  }
  /** Agent logins for cloud workspaces, kept by the runner. */
  logins: {
    status(): Promise<AgentLogins>
    connectClaude(token: string): Promise<void>
    connectCodex(): Promise<CodexSignIn>
    connectGithub(): Promise<{ url: string }>
    checkGithub(): Promise<void>
    disconnect(provider: AgentLoginProvider): Promise<void>
  }
  onCloudStatus(cb: (status: CloudStatus) => void): () => void
  ports: {
    list(workspaceId: string): Promise<PortForward[]>
    forward(workspaceId: string, port: number, localPort?: number): Promise<PortForward>
    unforward(workspaceId: string, port: number): Promise<void>
  }
  onWorkspacePower(cb: (push: WorkspacePowerPush) => void): () => void
  onNotification(cb: (notification: Notification) => void): () => void
  onSessionEvent(cb: (push: SessionEventPush) => void): () => void
  onSessionActivity(cb: (push: SessionActivity) => void): () => void
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
