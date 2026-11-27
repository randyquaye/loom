import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { ProjectRow } from '../../shared/ipc-contract'
import { DEFAULT_AGENT_MODES } from '../../shared/models'
import { runnerSchemas, type RunnerContract, type UserInstructions } from '../../shared/runner-contract'
import { RUNNER_CAPABILITIES, supportsBots } from '../../shared/runner-capabilities'
import { attachmentFileName, writeAttachment } from '../context/materialize'
import { getProjectOrThrow, insertProject, listProjects } from '../db/repos/projects'
import { getWorkspaceOrThrow, listWorkspaces } from '../db/repos/workspaces'
import { deleteEnvVar, envNames, listEnvVars, setEnvVar } from '../env/vars'
import type { Logins } from '../logins/service'
import type { Notifications } from '../notifications/service'
import { assertCloneableUrl } from '../git/projects'
import { slugify } from '../git/slug'
import { composeInstructions } from '../instructions/compose'
import { registerCommentsIpc } from '../ipc/comments'
import { registerFilesIpc } from '../ipc/files'
import { registerGitIpc } from '../ipc/git'
import { registerGithubIpc } from '../ipc/github'
import { registerHistoryIpc, searchHistory } from '../ipc/history'
import { registerLintIpc } from '../ipc/lint'
import { registerNotificationsIpc } from '../ipc/notifications'
import { handle, register, type Caller, type IpcDeps } from '../ipc/registry'
import { registerSessionsIpc } from '../ipc/sessions'
import { registerTerminalIpc } from '../ipc/terminal'
import { registerWorkspacesIpc } from '../ipc/workspaces'
import { AttachmentError } from '../sessions/attachments'
import {
  createSession,
  cancelTurn,
  forkSession,
  sendNow,
  sendTurn,
  sessionActivity,
  steerTurn
} from '../sessions/service'
import { unreadSessions } from '../sessions/unread'
import { rejectDelivery } from '../sessions/deliveries'
import { createWorkspace, removeWorkspace } from '../workspace/bootstrap'
import type { WorkspacePlacement } from '../workspace/placement'
import type { WorkspacePowerService } from '../workspace/power'
import { cloudHealth } from './health'
import type { AccessRules } from './access'
import type { OrgService } from '../org/service'
import type { RunnerAdmission } from './admission'
import type { SignInConfig } from './runner'
import { readBot } from '../bots/repository'
import { compileBotInstructions } from '../bots/execution'
import type { BotConfig } from '../../shared/bots'
import { markSessionRead } from '../sessions/unread'
import { answerQuestion, stopSessionWork, steerQueued } from '../sessions/service'
import { registerMobileDiscovery } from './mobile'

export interface RunnerHandlerOptions {
  placement: WorkspacePlacement
  /**
   * Lets a project's remote be a path on the runner's own disk. Only for a runner on a
   * developer's laptop: on a shared host it would let one user clone another's checkout.
   */
  allowLocalRemotes: boolean
  access: AccessRules
  /** Present on a runner that keeps its users' agent logins itself. */
  logins: Logins | null
  power?: WorkspacePowerService
  notifications?: Notifications
  org?: OrgService | null
  admission?: RunnerAdmission
  signIn?: SignInConfig | undefined
  removeMember?(actorId: string, userId: string): Promise<void>
  purgeMember?(actorId: string, userId: string): Promise<void>
}

/** A runner always knows who is calling; the desktop's window is the only caller that has no name. */
function signedIn(caller: Caller | undefined): Caller {
  if (caller === undefined) throw new Error('this call needs a signed-in user')
  return caller
}

type Handler<K extends keyof RunnerContract> = (
  input: RunnerContract[K]['in'],
  caller?: Caller
) => Promise<RunnerContract[K]['out']> | RunnerContract[K]['out']

function handleRunner<K extends keyof RunnerContract>(channel: K, fn: Handler<K>): void {
  register(channel, runnerSchemas[channel], fn as (input: unknown) => unknown)
}

/** Workspace folders are named after the project, so two remotes may not share a name. */
function uniqueProjectName(db: Database.Database, name: string): string {
  const taken = new Set(listProjects(db).map((project) => slugify(project.name)))
  let candidate = name
  for (let n = 2; taken.has(slugify(candidate)); n += 1) candidate = `${name}-${n}`
  return candidate
}

/**
 * A runner has no checkout of its own: a project is its remote address, which is both what
 * identifies it and where its workspaces are cloned from.
 */
export function ensureProject(
  db: Database.Database,
  input: RunnerContract['projects:ensure']['in'],
  allowLocalRemotes: boolean
): ProjectRow {
  if (!(allowLocalRemotes && path.isAbsolute(input.remoteUrl))) assertCloneableUrl(input.remoteUrl)
  const existing = db.prepare('SELECT id FROM projects WHERE remote_url = ?').get(input.remoteUrl) as
    { id: string } | undefined
  if (existing !== undefined) return getProjectOrThrow(db, existing.id)
  const project: ProjectRow = {
    id: randomUUID(),
    name: uniqueProjectName(db, input.name),
    repoPath: input.remoteUrl,
    remoteUrl: input.remoteUrl,
    createdAt: Date.now(),
    customPromptGeneral: null,
    customPromptCodeReview: null,
    customPromptFixErrors: null
  }
  insertProject(db, project)
  return project
}

/** The whole instruction text for a new tab: Loom's rules here, the user's text from their Mac. */
async function instructionSnapshot(
  db: Database.Database,
  workspaceId: string,
  instructions: UserInstructions
): Promise<string> {
  const workspace = getWorkspaceOrThrow(db, workspaceId)
  if (workspace.ownerId !== null && readBot(db, workspace.ownerId) !== null) {
    const invocation = db
      .prepare('SELECT config FROM bot_invocations WHERE workspace_id = ?')
      .get(workspaceId) as { config: string } | undefined
    if (invocation === undefined) throw new Error('Bot workspace has no configuration snapshot')
    return compileBotInstructions(JSON.parse(invocation.config) as BotConfig)
  }
  return composeInstructions({
    repositoryInstructions: [],
    overlay: instructions.overlay,
    general: instructions.general,
    envNames: await envNames(workspace.projectId, workspace.ownerId),
    container: workspace.runtime === 'container'
  })
}

type Delivery = (messageId: string, deliver: () => Promise<void>) => Promise<void>

/**
 * Delivers a message once under its ID, however many times it arrives: a desktop sends a
 * message again, under the same ID, when its connection drops before the answer comes.
 *
 * - While the first arrival is still being delivered, a later one gets that delivery's
 *   outcome. It is not answered sooner: the message may yet be turned away.
 * - After a delivery that worked, a later arrival does nothing, also on a runner that has
 *   restarted since.
 * - A failure before the input is recorded frees the ID for a later attempt. An input
 *   already in its transcript or queue keeps its identity even if later work fails.
 */
function deliverOnce(db: Database.Database): Delivery {
  const underWay = new Map<string, Promise<void>>()
  return (messageId, deliver) => {
    const earlier = underWay.get(messageId)
    if (earlier !== undefined) return earlier
    if (db.prepare('SELECT 1 FROM accepted_messages WHERE id = ?').get(messageId) !== undefined)
      return Promise.resolve()
    const delivery = Promise.resolve()
      .then(deliver)
      .catch((error: unknown) => {
        if (
          db.open &&
          !rejectDelivery(db, messageId) &&
          db.prepare('SELECT 1 FROM accepted_messages WHERE id = ?').get(messageId) !== undefined
        )
          return
        throw error
      })
      .finally(() => underWay.delete(messageId))
    underWay.set(messageId, delivery)
    return delivery
  }
}

/**
 * An absolute path would name a file on the runner's host, which no desktop may read. A
 * file from the Mac arrives through files:upload and is then attached by its workspace path.
 */
function assertWorkspaceRelative(attachments: readonly string[]): void {
  if (attachments.some((attachment) => path.isAbsolute(attachment))) {
    throw new AttachmentError('a cloud turn can only attach files inside its workspace')
  }
}

/**
 * Everything a runner answers. The first block is the desktop's own handlers, unchanged; the
 * second is the calls only a runner has, and the ones it takes with more input.
 */
export function registerRunnerHandlers(deps: IpcDeps, options: RunnerHandlerOptions): void {
  const { db } = deps

  registerMobileDiscovery(db, options.access)

  handle('app:ping', () => 'pong')
  const authorizeControl = (caller: Caller | undefined, workspaceId: string) => {
    const identity = signedIn(caller)
    options.admission?.assertMember(identity.userId)
    options.access.assertMayCall(identity, 'terminal:create', { workspaceId })
    const workspace = getWorkspaceOrThrow(db, workspaceId)
    if (workspace.ownerId !== null && readBot(db, workspace.ownerId) !== null && workspace.state !== 'ready')
      throw new Error('Wait for bot workspace setup to finish before using its terminal')
  }
  registerWorkspacesIpc(deps, options.placement, authorizeControl)
  registerGitIpc(deps)
  registerFilesIpc(deps)
  registerLintIpc(deps)
  registerTerminalIpc(deps, authorizeControl)
  registerSessionsIpc(deps)
  registerCommentsIpc(deps)
  registerHistoryIpc(deps)
  if (options.notifications !== undefined) registerNotificationsIpc(options.notifications)
  handle('cloud:health', (_input, caller) =>
    options.org === null || options.org === undefined || options.org.owner(signedIn(caller).userId)
      ? cloudHealth(deps.dataRoot)
      : null
  )
  const organization = (): OrgService => {
    if (options.org === null || options.org === undefined)
      throw new Error('This development runner has no organization')
    return options.org
  }
  handle('org:get', async (_input, caller) => {
    const overview = options.org?.current(signedIn(caller).userId) ?? null
    if (overview === null || overview.role !== 'owner') return overview
    return {
      ...overview,
      settings: {
        ...(options.signIn?.mode === 'managed' ? { mode: options.signIn.mode } : {}),
        domains: options.signIn?.domains ?? [],
        googleClientId: options.signIn?.googleClientId ?? ''
      },
      health: await cloudHealth(deps.dataRoot),
      usage: db
        .prepare(
          `SELECT u.id AS userId, u.email,
        COUNT(CASE WHEN w.power_state IN ('starting','running','stopping','error')
          OR w.state IN ('initializing','setting_up') THEN 1 END) AS running
        FROM org_members m JOIN users u ON u.id = m.user_id
        LEFT JOIN workspaces w ON w.owner_id = u.id
        GROUP BY u.id ORDER BY u.email`
        )
        .all() as Array<{ userId: string; email: string; running: number }>
    }
  })
  handle('org:update', ({ name }, caller) => organization().rename(signedIn(caller).userId, name))
  handle('org:members', (_input, caller) => {
    const signed = signedIn(caller)
    const members = organization().members(signed.userId)
    return supportsBots(signed.capabilities ?? RUNNER_CAPABILITIES)
      ? members
      : members.filter((member) => member.kind === 'human')
  })
  handle('org:invite', ({ email }, caller) => organization().createInvite(signedIn(caller).userId, email))
  handle('org:invites', (_input, caller) => organization().invites(signedIn(caller).userId))
  handle('org:revokeInvite', ({ id }, caller) => organization().revokeInvite(signedIn(caller).userId, id))
  handle('org:setRole', ({ userId, role }, caller) =>
    organization().setRole(signedIn(caller).userId, userId, role)
  )
  handle('org:removeMember', ({ userId }, caller) => {
    if (options.removeMember === undefined) throw new Error('Member cleanup is not available')
    return options.removeMember(signedIn(caller).userId, userId)
  })
  handle('org:purgeMember', ({ userId }, caller) => {
    if (options.purgeMember === undefined) throw new Error('Member cleanup is not available')
    return options.purgeMember(signedIn(caller).userId, userId)
  })
  handle('org:log', ({ before }, caller) => organization().adminLog(signedIn(caller).userId, before))
  if (options.power !== undefined) {
    const { power } = options
    handle('workspaces:power', ({ workspaceId }) => power.refresh(workspaceId))
    handle('workspaces:start', ({ workspaceId }) => power.start(workspaceId))
    handle('workspaces:stop', ({ workspaceId }) => power.stop(workspaceId))
    handle('workspaces:remove', ({ id }) => {
      const remove = async () => {
        const workspace = getWorkspaceOrThrow(db, id)
        const project = getProjectOrThrow(db, workspace.projectId)
        await removeWorkspace({ db, repoPath: project.repoPath, workspace, dataRoot: deps.dataRoot })
      }
      return getWorkspaceOrThrow(db, id).runtime === 'container' ? power.remove(id, remove) : remove()
    })
  }

  // The window's handlers answer for the one user of a Mac. These answer for the caller alone.
  const visibleWorkspaceIds = (caller: Caller): string[] =>
    (db.prepare('SELECT id FROM workspaces').all() as Array<{ id: string }>)
      .filter((row) => options.access.mayViewWorkspace(caller.userId, row.id, caller.capabilities))
      .map((row) => row.id)
  handle('workspaces:list', ({ projectId }, caller) => {
    const { userId, capabilities } = signedIn(caller)
    return listWorkspaces(db, projectId)
      .filter((row) => options.access.mayViewWorkspace(userId, row.id, capabilities))
      .map((row) => {
        const bot = row.ownerId === null ? null : readBot(db, row.ownerId)
        return bot === null
          ? row
          : {
              ...row,
              bot: {
                id: bot.id,
                access: options.access.mayControlWorkspace(userId, row.id, capabilities)
                  ? ('control' as const)
                  : ('view' as const)
              }
            }
      })
  })
  // Every workspace made here is stamped: with what its owner chose, or with the defaults.
  handle('workspaces:add', ({ projectId, name, baseRef, modes }, caller) => {
    const userId = signedIn(caller).userId
    const create = () =>
      createWorkspace({
        db,
        dataRoot: deps.dataRoot,
        projectId,
        name,
        baseRef,
        ownerId: userId,
        modes: modes ?? DEFAULT_AGENT_MODES,
        ...options.placement
      })
    return options.admission === undefined ? create() : options.admission.create(userId, create)
  })
  handle('sessions:activity', (_input, caller) => {
    const signed = signedIn(caller)
    return options.access.activityFor(signed.userId, sessionActivity(), signed.capabilities)
  })
  handle('sessions:unread', (_input, caller) => {
    const signed = signedIn(caller)
    return unreadSessions(db, signed.userId, visibleWorkspaceIds(signed))
  })
  handle('sessions:markRead', ({ sessionId, seq }, caller) =>
    markSessionRead(db, sessionId, seq, signedIn(caller).userId)
  )
  handle('sessions:cancel', ({ sessionId }) => {
    const owner = options.access.ownerOf('session', sessionId)
    return owner !== null && readBot(db, owner) !== null
      ? stopSessionWork(db, sessionId)
      : cancelTurn(db, sessionId)
  })
  handle('sessions:answerQuestion', ({ sessionId, answer }, caller) =>
    answerQuestion(db, sessionId, answer, signedIn(caller).userId)
  )
  handle('sessions:steerQueued', ({ sessionId, messageId }, caller) =>
    steerQueued(db, sessionId, messageId, signedIn(caller).userId)
  )

  // Agent logins, likewise each person's own. A runner that leaves logins in the home folder
  // says so, and has nothing to connect.
  const { logins } = options
  const keeper = (): Logins => {
    if (logins === null) throw new Error('This runner does not keep agent logins')
    return logins
  }
  registerGithubIpc(
    deps,
    (caller, workspaceId) =>
      keeper().githubExec(
        workspaceId === undefined
          ? signedIn(caller).userId
          : (getWorkspaceOrThrow(db, workspaceId).ownerId ?? signedIn(caller).userId)
      ),
    (caller, workspaceId) =>
      options.access.mayViewWorkspace(caller.userId, workspaceId, caller.capabilities ?? [])
  )
  handle('logins:status', (_input, caller) =>
    logins === null
      ? { managed: false, claude: false, codex: false, github: false, codexSigningIn: false }
      : logins.status(signedIn(caller).userId)
  )
  // A connection is started and finished by the same signed-in desktop; see github-connect.ts.
  handleRunner('logins:connectGithub', ({ callback }, caller) =>
    keeper().connectGithub(signedIn(caller).userId, callback)
  )
  handleRunner('logins:finishGithub', ({ claim }, caller) =>
    keeper().finishGithub(signedIn(caller).userId, claim)
  )
  handle('logins:checkGithub', (_input, caller) => keeper().checkGithub(signedIn(caller).userId))
  handle('logins:connectCodex', (_input, caller) => keeper().connectCodex(signedIn(caller).userId))
  handle('logins:connectClaude', ({ token }, caller) =>
    keeper().connectClaude(signedIn(caller).userId, token)
  )
  handle('logins:disconnect', ({ provider }, caller) =>
    keeper().disconnect(signedIn(caller).userId, provider)
  )

  // Environment values are kept under the person who set them. The project they name is
  // shared, so these calls are open, and it is the caller who decides whose values they touch.
  handle('env:list', ({ scope, projectId }, caller) => listEnvVars(scope, projectId, signedIn(caller).userId))
  handle('env:set', ({ scope, projectId, name, value }, caller) =>
    setEnvVar(scope, projectId, name, value, signedIn(caller).userId)
  )
  handle('env:delete', ({ scope, projectId, name }, caller) =>
    deleteEnvVar(scope, projectId, name, signedIn(caller).userId)
  )
  handle('history:search', ({ query, projectId }, caller) => {
    const signed = signedIn(caller)
    return searchHistory(db, query, projectId, signed.userId, visibleWorkspaceIds(signed))
  })

  handleRunner('projects:ensure', (input) => ensureProject(db, input, options.allowLocalRemotes))

  handleRunner('files:upload', ({ sessionId, name, dataBase64 }) => {
    const tab = db
      .prepare(
        'SELECT w.worktree_path FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.id = ?'
      )
      .get(sessionId) as { worktree_path: string } | undefined
    if (tab === undefined) throw new Error(`unknown session ${sessionId}`)
    return writeAttachment(
      tab.worktree_path,
      attachmentFileName('upload', name, Date.now()),
      Buffer.from(dataBase64, 'base64')
    )
  })

  handleRunner('sessions:create', async ({ instructions, ...input }) => {
    const workspace = getWorkspaceOrThrow(db, input.workspaceId)
    if (workspace.ownerId !== null && readBot(db, workspace.ownerId) !== null) {
      const pinned = db
        .prepare('SELECT config FROM bot_invocations WHERE workspace_id = ?')
        .get(input.workspaceId) as { config: string } | undefined
      if (pinned === undefined) throw new Error('Bot configuration snapshot is missing')
      const config = JSON.parse(pinned.config) as BotConfig
      if (input.backend !== config.backend || input.model !== config.model || input.effort !== config.effort)
        throw new Error('A bot conversation uses its workspace configuration')
    }
    return createSession(db, input, await instructionSnapshot(db, input.workspaceId, instructions))
  })

  handleRunner('sessions:fork', async ({ instructions, ...input }) => {
    const workspace = getWorkspaceOrThrow(db, input.workspaceId)
    if (workspace.ownerId !== null && readBot(db, workspace.ownerId) !== null)
      throw new Error('Start a new bot conversation instead of forking a bot transcript')
    return forkSession(db, input, await instructionSnapshot(db, input.workspaceId, instructions))
  })

  // The three ways a message reaches a tab. Each is delivered once under its ID.
  const once = deliverOnce(db)
  const messages = {
    'sessions:send': sendTurn,
    'sessions:steer': steerTurn,
    'sessions:sendNow': sendNow
  } as const
  for (const channel of Object.keys(messages) as Array<keyof typeof messages>) {
    handleRunner(channel, ({ sessionId, text, attachments, messageId }, caller) => {
      assertWorkspaceRelative(attachments)
      return once(messageId, () =>
        messages[channel](db, sessionId, text, attachments, [], messageId, signedIn(caller).userId)
      )
    })
  }
}
