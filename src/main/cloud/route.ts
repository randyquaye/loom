import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import {
  CLOUD_STATUS_CHANNEL,
  WORKSPACE_POWER_CHANNEL,
  SESSION_ACTIVITY_CHANNEL,
  TERMINAL_DATA_CHANNEL,
  TERMINAL_EXIT_CHANNEL,
  type HistoryHit,
  type IpcContract,
  type ProjectRow,
  type SessionActivity,
  type SessionUnread,
  type TerminalDataPush,
  type TerminalExitPush,
  type TerminalInfo,
  type WorkspaceRow,
  type WorkspacePowerPush,
  type WorkspacePower
} from '../../shared/ipc-contract'
import { CALL_SUBJECTS, type SubjectKind } from '../../shared/call-subjects'
import { MAX_IMAGE_ATTACHMENT_BYTES } from '../../shared/limits'
import type { RunnerContract } from '../../shared/runner-contract'
import { getProject, getProjectOrThrow } from '../db/repos/projects'
import { getWorkspace } from '../db/repos/workspaces'
import { userInstructions } from '../instructions/user'
import { call, parseInput } from '../ipc/registry'
import { hasTerminal } from '../pty'
import { AttachmentError, resolveAttachment } from '../sessions/attachments'
import { sessionActivity } from '../sessions/service'
import { connectRunner, RunnerUnreachableError, type ClientState, type RunnerAuth } from './client'
import { listenForBrowser, type BrowserReturn } from './sign-in'
import { setCloudStatus } from './status'
import { createPortForwards } from './port-forwards'

export interface CloudRouteOptions extends RunnerAuth {
  db: Database.Database
  dataRoot: string
  /** ws:// or wss:// address of the runner. */
  url: string
  protocol?: number
  /** Delivers a live update to the window. */
  toWindow(channel: string, payload: unknown): void
}

export interface CloudRoute {
  /** Answers every call from the window, from this Mac or from the runner. */
  route(channel: string, input: unknown): unknown
  /** This Mac's own live updates pass through here on their way to the window. */
  fromLocal(channel: string, payload: unknown): void
  /** Tries the runner again now, for instance right after signing in. */
  reconnect(): void
  close(): void
}

type In<K extends keyof IpcContract> = IpcContract[K]['in']
/** Calls that need the Mac itself, so they have no meaning for files on a server. */
const MAC_ONLY: Partial<Record<keyof IpcContract, string>> = {
  'files:reveal': 'Cloud files live on the server and cannot be shown in Finder',
  'sessions:exportMarkdown': 'Exporting a cloud tab is not available yet'
}

/**
 * Stands in for the runner. The window keeps making the calls it always made; this decides,
 * call by call, whether this Mac answers or the runner does, and makes the two look like one
 * Loom: one list of workspaces per project, one set of busy tabs, one stream of updates.
 */
export function createCloudRoute(options: CloudRouteOptions): CloudRoute {
  const { db, dataRoot, toWindow } = options
  let state: ClientState['state'] = 'connecting'
  /** Runner project ids by local project id, and the reverse for results coming back. */
  const runnerProjects = new Map<string, string>()
  const localProjects = new Map<string, string>()
  /** Cloud workspace rows as last shown to the window, under their local project id. */
  const cloudWorkspaces = new Map<string, WorkspaceRow>()
  /** Keep exits too: a late create/list reply must not revive an ended terminal. */
  const cloudTerminals = new Map<string, 'live' | 'exited'>()
  let localActivity = sessionActivity()
  let cloudActivity: Record<string, string> = {}
  let activityRevision = localActivity.revision
  /** Counts connection changes, so an answer that arrives after the next change is dropped. */
  let connection = 0
  const forwards = createPortForwards({
    url: options.url,
    token: options.token,
    isConnected: () => state === 'connected',
    async check(workspaceId) {
      const power = await runner<WorkspacePower>('workspaces:power', { workspaceId })
      if (power.state !== 'running') throw new Error('Start the workspace before forwarding a port')
    }
  })

  const client = connectRunner({
    url: options.url,
    token: options.token,
    ...(options.onRefused === undefined ? {} : { onRefused: options.onRefused }),
    ...(options.protocol === undefined ? {} : { protocol: options.protocol }),
    onPush: fromRunner,
    onState: changed
  })

  function rememberTerminal(id: string): void {
    if (!cloudTerminals.has(id)) cloudTerminals.set(id, 'live')
  }

  async function runner<T>(channel: string, input: unknown): Promise<T> {
    const result = await client.call(channel, input)
    if (channel === 'terminal:create' || channel === 'workspaces:runAction') {
      rememberTerminal(result as string)
    } else if (channel === 'terminal:list') {
      for (const terminal of result as TerminalInfo[]) rememberTerminal(terminal.id)
    } else if (channel === 'terminal:destroy') {
      cloudTerminals.set((input as In<'terminal:destroy'>).id, 'exited')
    }
    return result as T
  }

  const isLocal: Record<SubjectKind, (id: string) => boolean> = {
    workspace: (id) => getWorkspace(db, id) !== null,
    session: (id) => db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id) !== undefined,
    // Unknown and exited terminals use the local handlers' existing no-op behavior.
    terminal: (id) => hasTerminal(id) || cloudTerminals.get(id) !== 'live',
    comment: (id) => db.prepare('SELECT 1 FROM diff_comments WHERE id = ?').get(id) !== undefined
  }

  function activity(): SessionActivity {
    return { revision: activityRevision, bySession: { ...localActivity.bySession, ...cloudActivity } }
  }

  /** The window keeps only a newer revision, so every change on either side bumps it. */
  function pushActivity(): void {
    activityRevision += 1
    toWindow(SESSION_ACTIVITY_CHANNEL, activity())
  }

  function fromRunner(channel: string, payload: unknown): void {
    if (channel === WORKSPACE_POWER_CHANNEL) {
      const push = payload as WorkspacePowerPush
      if (push.state !== 'running' && push.state !== 'starting')
        void forwards.closeWorkspace(push.workspaceId)
    }
    if (channel === TERMINAL_DATA_CHANNEL) rememberTerminal((payload as TerminalDataPush).id)
    if (channel === TERMINAL_EXIT_CHANNEL) cloudTerminals.set((payload as TerminalExitPush).id, 'exited')
    if (channel !== SESSION_ACTIVITY_CHANNEL) return toWindow(channel, payload)
    cloudActivity = (payload as SessionActivity).bySession
    pushActivity()
  }

  function changed(next: ClientState): void {
    state = next.state
    if (next.state !== 'connected') forwards.disconnect()
    if (next.state === 'signed-out' || next.state === 'update') void forwards.clear()
    connection += 1
    // A runner that came back may be a fresh one; ask again rather than trust old ids.
    runnerProjects.clear()
    localProjects.clear()
    // Nothing is known about cloud tabs until the runner has been asked again.
    cloudActivity = {}
    pushActivity()
    setCloudStatus(next)
    toWindow(CLOUD_STATUS_CHANNEL, next)
    if (next.state === 'connected') void refreshCloudActivity(connection)
  }

  async function refreshCloudActivity(asked: number): Promise<void> {
    const snapshot = await runner<SessionActivity>('sessions:activity', undefined).catch(() => null)
    if (snapshot === null || asked !== connection) return
    cloudActivity = snapshot.bySession
    pushActivity()
  }

  async function runnerProject(project: ProjectRow): Promise<string> {
    if (project.remoteUrl === null) {
      throw new Error(`"${project.name}" has no Git remote, so it cannot have cloud workspaces`)
    }
    const known = runnerProjects.get(project.id)
    if (known !== undefined) return known
    const ensured = await runner<ProjectRow>('projects:ensure', {
      name: project.name,
      remoteUrl: project.remoteUrl
    } satisfies RunnerContract['projects:ensure']['in'])
    runnerProjects.set(project.id, ensured.id)
    localProjects.set(ensured.id, project.id)
    return ensured.id
  }

  /** The window knows a project by its local id only; the runner's id never reaches it. */
  function asCloud(row: WorkspaceRow, localProjectId: string): WorkspaceRow {
    const shown: WorkspaceRow = { ...row, projectId: localProjectId, cloud: true }
    cloudWorkspaces.set(row.id, shown)
    return shown
  }

  async function listWorkspaces(input: In<'workspaces:list'>): Promise<WorkspaceRow[]> {
    const local = (await call('workspaces:list', input)) as WorkspaceRow[]
    const project = getProject(db, input.projectId)
    const cached = [...cloudWorkspaces.values()].filter(
      (workspace) => workspace.projectId === input.projectId
    )
    if (state !== 'connected') return [...local, ...cached]
    if (project === null || project.remoteUrl === null) return local
    try {
      const remote = await runner<WorkspaceRow[]>('workspaces:list', {
        projectId: await runnerProject(project)
      })
      for (const old of cached) cloudWorkspaces.delete(old.id)
      return [...local, ...remote.map((row) => asCloud(row, project.id))]
    } catch (error) {
      // Local workspaces must still list when the runner drops mid-call.
      if (error instanceof RunnerUnreachableError) return [...local, ...cached]
      throw error
    }
  }

  async function addWorkspace(input: In<'workspaces:add'>): Promise<WorkspaceRow> {
    if (!input.cloud) return (await call('workspaces:add', input)) as WorkspaceRow
    const project = getProjectOrThrow(db, input.projectId)
    const created = await runner<WorkspaceRow>('workspaces:add', {
      projectId: await runnerProject(project),
      name: input.name,
      baseRef: input.baseRef
    })
    return asCloud(created, project.id)
  }

  /** A new cloud tab takes the user's instructions from this Mac, where they are written. */
  async function withInstructions<T extends { workspaceId: string }>(
    channel: 'sessions:create' | 'sessions:fork',
    input: T
  ): Promise<unknown> {
    const workspace = cloudWorkspaces.get(input.workspaceId)
    if (workspace === undefined) throw new Error(`unknown cloud workspace ${input.workspaceId}`)
    return runner(channel, {
      ...input,
      instructions: await userInstructions(db, dataRoot, workspace.projectId)
    })
  }

  /**
   * The runner cannot read this Mac, so a file attached by its path here is uploaded and
   * attached by where it landed. It passes this Mac's own checks first: the credential
   * deny-list and the size cap.
   */
  async function uploaded(sessionId: string, attachment: string): Promise<string> {
    if (!path.isAbsolute(attachment)) return attachment
    const { abs } = await resolveAttachment(tmpdir(), attachment, [dataRoot])
    if ((await stat(abs)).size > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new AttachmentError(`larger than ${MAX_IMAGE_ATTACHMENT_BYTES} bytes: ${abs}`)
    }
    return runner<string>('files:upload', {
      sessionId,
      name: path.basename(abs),
      dataBase64: (await readFile(abs)).toString('base64')
    } satisfies RunnerContract['files:upload']['in'])
  }

  /** Each message gets its identity here, once; a retry after a dropped connection reuses it. */
  async function sendMessage(channel: string, input: In<'sessions:send'>): Promise<unknown> {
    const attachments: string[] = []
    for (const attachment of input.attachments) attachments.push(await uploaded(input.sessionId, attachment))
    return client.callIdentified(channel, { ...input, attachments, messageId: randomUUID() })
  }

  async function unread(): Promise<Record<string, SessionUnread>> {
    const local = (await call('sessions:unread', undefined)) as Record<string, SessionUnread>
    if (state !== 'connected') return local
    const remote = await runner<Record<string, SessionUnread>>('sessions:unread', undefined).catch(() => ({}))
    return { ...local, ...remote }
  }

  /**
   * Values for cloud workspaces live on the runner, encrypted there, and never on this Mac.
   * The window names a project as this Mac knows it; the runner keeps it under its own.
   */
  async function environment(channel: string, input: In<'env:list'>): Promise<unknown> {
    if (!input.cloud) return call(channel as keyof IpcContract, input)
    const projectId =
      input.projectId === null ? null : await runnerProject(getProjectOrThrow(db, input.projectId))
    return runner(channel, { ...input, projectId, cloud: false })
  }

  /** The port this desktop is listening on for a GitHub connection it started, if it is. */
  let githubReturn: BrowserReturn | null = null

  /**
   * GitHub's approval happens in a browser, and a link can be opened by anyone it is passed
   * to. So the runner sends the browser back here, to a port of this Mac's own, with a
   * one-time claim, and only this signed-in desktop can then make the connection its
   * person's. Starting again stops waiting for the earlier one.
   */
  async function connectGithub(): Promise<{ url: string }> {
    githubReturn?.close()
    const waiting = await listenForBrowser({
      async onReturn(query) {
        await runner('logins:finishGithub', { claim: query.get('claim') ?? '' })
        return 'GitHub is connected. You can close this tab and return to Loom.'
      }
    })
    githubReturn = waiting
    try {
      return await runner<{ url: string }>('logins:connectGithub', { callback: waiting.callback })
    } catch (error) {
      waiting.close()
      throw error
    }
  }

  /** Each side is searched on its own; cloud hits are shown under the project this Mac knows. */
  async function searchHistory(input: In<'history:search'>): Promise<HistoryHit[]> {
    const local = (await call('history:search', input)) as HistoryHit[]
    const projectId = input.projectId === null ? null : runnerProjects.get(input.projectId)
    if (state !== 'connected' || projectId === undefined) return local
    const remote = await runner<HistoryHit[]>('history:search', { query: input.query, projectId }).catch(
      (): HistoryHit[] => []
    )
    const shown = remote.flatMap((hit) => {
      const project = getProject(db, localProjects.get(hit.projectId) ?? '')
      return project === null ? [] : [{ ...hit, projectId: project.id, projectLabel: project.name }]
    })
    return [...local, ...shown]
  }

  async function projectGithub(
    channel: 'github:prs' | 'github:branchPrs',
    input: In<'github:prs'> | In<'github:branchPrs'>
  ): Promise<unknown> {
    if (!input.cloud) return call(channel, input)
    const projectId = await runnerProject(getProjectOrThrow(db, input.projectId))
    return runner(channel, { ...input, projectId, cloud: false })
  }

  function aboutThisMac(channel: keyof IpcContract, parsed: unknown): boolean {
    const subject = CALL_SUBJECTS[channel]
    if (subject === undefined) return true
    const [kind, field] = subject
    return isLocal[kind]((parsed as Record<string, string>)[field] ?? '')
  }

  function route(name: string, input: unknown): unknown {
    const channel = name as keyof IpcContract
    const parsed = parseInput(channel, input)
    switch (channel) {
      case 'workspaces:list':
        return listWorkspaces(parsed as In<'workspaces:list'>)
      case 'workspaces:add':
        return addWorkspace(parsed as In<'workspaces:add'>)
      case 'cloud:health':
        return state === 'connected' ? runner(channel, parsed) : null
      case 'ports:list':
        return forwards.list((parsed as In<'ports:list'>).workspaceId)
      case 'ports:forward': {
        const input = parsed as In<'ports:forward'>
        if (aboutThisMac(channel, parsed)) return call(channel, parsed)
        return forwards.forward(input.workspaceId, input.port, input.localPort)
      }
      case 'ports:unforward': {
        const input = parsed as In<'ports:unforward'>
        return forwards.unforward(input.workspaceId, input.port)
      }
      case 'sessions:activity':
        return activity()
      case 'sessions:unread':
        return unread()
      case 'history:search':
        return searchHistory(parsed as In<'history:search'>)
      case 'env:list':
      case 'env:set':
      case 'env:delete':
        return environment(channel, parsed as In<'env:list'>)
      case 'github:prs':
      case 'github:branchPrs':
        return projectGithub(channel, parsed as In<'github:prs'>)
      case 'logins:status':
        // With the runner out of reach there is nothing to say about what it keeps.
        return state === 'connected' ? runner(channel, parsed) : call(channel, parsed)
      case 'logins:connectGithub':
        return connectGithub()
      case 'logins:connectClaude':
      case 'logins:connectCodex':
      case 'logins:checkGithub':
      case 'logins:disconnect':
        return runner(channel, parsed)
      default:
    }
    if (aboutThisMac(channel, parsed)) return call(channel, parsed)
    const refusal = MAC_ONLY[channel]
    if (refusal !== undefined) throw new Error(refusal)
    switch (channel) {
      case 'sessions:create':
      case 'sessions:fork':
        return withInstructions(channel, parsed as In<'sessions:create'>)
      case 'sessions:send':
      case 'sessions:steer':
      case 'sessions:sendNow':
        return sendMessage(channel, parsed as In<'sessions:send'>)
      case 'workspaces:remove':
        void forwards.closeWorkspace((parsed as In<'workspaces:remove'>).id)
        cloudWorkspaces.delete((parsed as In<'workspaces:remove'>).id)
        return runner(channel, parsed)
      default:
        return runner(channel, parsed)
    }
  }

  return {
    route,
    fromLocal(channel, payload) {
      if (channel !== SESSION_ACTIVITY_CHANNEL) return toWindow(channel, payload)
      localActivity = payload as SessionActivity
      pushActivity()
    },
    reconnect: () => client.reconnect(),
    close() {
      githubReturn?.close()
      void forwards.close()
      client.close()
    }
  }
}
