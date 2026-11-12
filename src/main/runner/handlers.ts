import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { ProjectRow } from '../../shared/ipc-contract'
import { runnerSchemas, type RunnerContract, type UserInstructions } from '../../shared/runner-contract'
import { attachmentFileName, writeAttachment } from '../context/materialize'
import { getProjectOrThrow, insertProject, listProjects } from '../db/repos/projects'
import { getWorkspaceOrThrow, listWorkspaces } from '../db/repos/workspaces'
import { deleteEnvVar, envNames, listEnvVars, setEnvVar } from '../env/vars'
import type { Logins } from '../logins/service'
import { assertCloneableUrl } from '../git/projects'
import { slugify } from '../git/slug'
import { composeInstructions } from '../instructions/compose'
import { registerCommentsIpc } from '../ipc/comments'
import { registerFilesIpc } from '../ipc/files'
import { registerGitIpc } from '../ipc/git'
import { registerGithubIpc } from '../ipc/github'
import { registerHistoryIpc, searchHistory } from '../ipc/history'
import { registerLintIpc } from '../ipc/lint'
import { handle, register, type Caller, type IpcDeps } from '../ipc/registry'
import { registerSessionsIpc } from '../ipc/sessions'
import { registerTerminalIpc } from '../ipc/terminal'
import { registerWorkspacesIpc } from '../ipc/workspaces'
import { AttachmentError } from '../sessions/attachments'
import {
  createSession,
  forkSession,
  sendNow,
  sendTurn,
  sessionActivity,
  steerTurn
} from '../sessions/service'
import { unreadSessions } from '../sessions/unread'
import { createWorkspace } from '../workspace/bootstrap'
import type { WorkspacePlacement } from '../workspace/placement'
import type { AccessRules } from './access'

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
function ensureProject(
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
  return composeInstructions({
    repositoryInstructions: [],
    overlay: instructions.overlay,
    general: instructions.general,
    envNames: await envNames(workspace.projectId, workspace.ownerId),
    container: workspace.runtime === 'container'
  })
}

/** True the first time an ID is seen, including by a runner that has since restarted. */
function acceptOnce(db: Database.Database, messageId: string): boolean {
  const inserted = db
    .prepare('INSERT OR IGNORE INTO accepted_messages (id, accepted_at) VALUES (?, ?)')
    .run(messageId, Date.now())
  return inserted.changes === 1
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

  handle('app:ping', () => 'pong')
  registerWorkspacesIpc(deps, options.placement)
  registerGitIpc(deps)
  registerFilesIpc(deps)
  registerLintIpc(deps)
  registerTerminalIpc(deps)
  registerSessionsIpc(deps)
  registerCommentsIpc(deps)
  registerHistoryIpc(deps)

  // The window's handlers answer for the one user of a Mac. These answer for the caller alone.
  handle('workspaces:list', ({ projectId }, caller) =>
    listWorkspaces(db, projectId).filter((row) => row.ownerId === signedIn(caller).userId)
  )
  handle('workspaces:add', ({ projectId, name, baseRef }, caller) =>
    createWorkspace({
      db,
      dataRoot: deps.dataRoot,
      projectId,
      name,
      baseRef,
      ownerId: signedIn(caller).userId,
      ...options.placement
    })
  )
  handle('sessions:activity', (_input, caller) =>
    options.access.activityFor(signedIn(caller).userId, sessionActivity())
  )
  handle('sessions:unread', (_input, caller) => unreadSessions(db, signedIn(caller).userId))

  // Agent logins, likewise each person's own. A runner that leaves logins in the home folder
  // says so, and has nothing to connect.
  const { logins } = options
  const keeper = (): Logins => {
    if (logins === null) throw new Error('This runner does not keep agent logins')
    return logins
  }
  registerGithubIpc(deps, (caller) => keeper().githubExec(signedIn(caller).userId))
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
  handle('history:search', ({ query, projectId }, caller) =>
    searchHistory(db, query, projectId, signedIn(caller).userId)
  )

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

  handleRunner('sessions:create', async ({ instructions, ...input }) =>
    createSession(db, input, await instructionSnapshot(db, input.workspaceId, instructions))
  )

  handleRunner('sessions:fork', async ({ instructions, ...input }) =>
    forkSession(db, input, await instructionSnapshot(db, input.workspaceId, instructions))
  )

  handleRunner('sessions:send', ({ sessionId, text, attachments, messageId }) => {
    assertWorkspaceRelative(attachments)
    if (acceptOnce(db, messageId)) return sendTurn(db, sessionId, text, attachments)
  })

  handleRunner('sessions:steer', ({ sessionId, text, attachments, messageId }) => {
    assertWorkspaceRelative(attachments)
    if (acceptOnce(db, messageId)) return steerTurn(db, sessionId, text, attachments)
  })

  handleRunner('sessions:sendNow', ({ sessionId, text, attachments, messageId }) => {
    assertWorkspaceRelative(attachments)
    if (acceptOnce(db, messageId)) return sendNow(db, sessionId, text, attachments)
  })
}
