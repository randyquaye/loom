import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import type Database from 'better-sqlite3'
import {
  SESSION_ACTIVITY_CHANNEL,
  SESSION_EVENT_CHANNEL,
  SESSION_QUEUE_CHANNEL,
  SESSION_TITLE_CHANNEL,
  TERMINAL_EXIT_CHANNEL,
  WORKSPACE_STATE_CHANNEL,
  WORKSPACE_POWER_CHANNEL,
  type WorkspacePowerPush
} from '../../shared/ipc-contract'
import { registerBackends } from '../agents/wiring'
import type { GoogleClient } from '../auth/google'
import { signInRoutes } from '../auth/routes'
import { signInIsLive, whoHolds } from '../auth/tokens'
import { openDb } from '../db'
import { ensureUser } from '../db/repos/users'
import { setEnvSecretStore } from '../env/vars'
import { call, parseInput } from '../ipc/registry'
import { destroyTerminalsForCwd, keepScrollback, setTerminalSink } from '../pty'
import {
  discardRuntime,
  containerName,
  homeFolder,
  HOMES_DIR,
  removeSignInContainers,
  setContainerLogins,
  setRuntimePowerGate,
  runtimeFor,
  signInRuntime,
  workspacesByAddress
} from '../runtime'
import { startLogins, type Logins, type SignInRun } from '../logins/service'
import type { LoginProvider } from '../logins/stand-in'
import type { GithubAppConfig } from '../logins/github'
import { aesGcmCipher, createSecretStore, type SecretStore } from '../secrets'
import { sqliteQueueStore } from '../sessions/queue-store'
import {
  closeInterruptedTurns,
  closeAllSessions,
  persistQueues,
  setActivitySink,
  setLoomDataRoot,
  setQueueSink,
  setSessionSink,
  setTitleSink,
  sessionActivity,
  suspendWorkspaceSessions
} from '../sessions/service'
import { setRemoteAccess, setWorkspaceStateSink } from '../workspace/bootstrap'
import type { WorkspacePlacement } from '../workspace/placement'
import { createWorkspacePower } from '../workspace/power'
import { getWorkspaceOrThrow } from '../db/repos/workspaces'
import { openForwardTarget } from '../runtime/forward'
import { containerIsRunning } from '../runtime/container'
import { createAccess } from './access'
import { registerRunnerHandlers } from './handlers'
import { sameSecret, startRunnerServer } from './server'

/**
 * A stand-in for sign-in: whoever presents the token is that user. For a runner on a
 * developer's own machine and for tests; a host where people sign in has none.
 */
export interface DevIdentity {
  token: string
  userId: string
  email: string
}

/** People prove who they are with Google, and the pilot list decides who gets in. */
export interface SignInConfig {
  google: GoogleClient
  /** Google Workspace domains whose accounts may sign in at all. */
  domains: string[]
  /** The pilot list. Being in the company is not enough. */
  isAdmitted(email: string): boolean
  /** The runner's own address as browsers and Google reach it. */
  publicUrl: string
}

export interface RunnerConfig {
  /** The one folder everything is written to: checkouts, homes, database, logs. */
  dataDir: string
  /** 32 bytes from host configuration; stands in for the Mac's Keychain. */
  secretKey: Buffer
  devIdentities: DevIdentity[]
  /** Absent on a developer's machine, where the stand-in tokens above are the only way in. */
  signIn?: SignInConfig
  host: string
  port: number
  placement: WorkspacePlacement
  allowLocalRemotes: boolean
  /**
   * Where the runner's login proxy listens and how containers reach it. With this the runner
   * keeps its users' agent logins itself; without it they stay in each home folder.
   */
  logins?: { host: string; port: number; fronts: Record<LoginProvider, string> }
  github?: GithubAppConfig
  idleMs?: number
}

export interface Runner {
  readonly port: number
  /** Stops listening and retires this process's sessions. Persisted turns recover on restart. */
  close(): Promise<void>
}

const SCROLLBACK_CHARS = 256 * 1024
const ACCEPTED_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * What a starting runner owes the tabs the previous process left behind. Nothing here sends
 * a message: turns that were running are closed as interrupted, queued messages wait for
 * the user, and containers are removed so their leftover processes go with them.
 */
async function recover(db: Database.Database): Promise<void> {
  const interrupted = closeInterruptedTurns(db)
  // A workspace caught mid-setup has nobody finishing it; say so instead of waiting forever.
  const stranded = db
    .prepare("UPDATE workspaces SET state = 'error' WHERE state IN ('initializing', 'setting_up')")
    .run().changes
  db.prepare(
    `DELETE FROM accepted_messages WHERE accepted_at < ?
    AND NOT EXISTS (SELECT 1 FROM pending_deliveries WHERE pending_deliveries.id = accepted_messages.id)
    AND NOT EXISTS (SELECT 1 FROM queued_messages WHERE queued_messages.id = accepted_messages.id)`
  ).run(Date.now() - ACCEPTED_MESSAGE_TTL_MS)
  const containers = db
    .prepare("SELECT id, runtime FROM workspaces WHERE runtime = 'container'")
    .all() as Array<{ id: string; runtime: 'container' }>
  for (const workspace of containers) {
    try {
      await discardRuntime(workspace)
      db.prepare("UPDATE workspaces SET power_state = 'stopped', power_error = NULL WHERE id = ?").run(
        workspace.id
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      db.prepare("UPDATE workspaces SET power_state = 'error', power_error = ? WHERE id = ?").run(
        message,
        workspace.id
      )
      console.warn(`[loom-runner] could not remove the container of workspace ${workspace.id}:`, message)
    }
  }
  if (interrupted > 0 || stranded > 0) {
    console.log(
      `[loom-runner] recovered: ${interrupted} turn(s) interrupted, ${stranded} workspace(s) failed`
    )
  }
}

/** Under the data folder: where sign-in programs run. Outside every home and checkout. */
const SIGN_INS_DIR = 'sign-ins'

/**
 * Runs Codex's own device sign-in in a container made for it and removed after it. The
 * sign-in it writes lands in a folder no workspace is ever given.
 */
async function codexSignIn(dataDir: string): Promise<SignInRun> {
  // Each sign-in has a place and a container of its own, so abandoning one cannot touch the next.
  const id = randomUUID()
  const home = path.join(dataDir, SIGN_INS_DIR, id)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const runtime = signInRuntime(dataDir, id, home)
  await runtime.ensureRunning()
  const { child, terminate } = runtime.spawn('codex', ['login', '--device-auth'])

  // Kept in a queue of its own: a reader that stops listening must not close the program's output.
  const printed: string[] = []
  let ended = false
  let wake: (() => void) | null = null
  const note = (chunk: Buffer): void => {
    printed.push(String(chunk))
    wake?.()
  }
  child.stdout.on('data', note)
  child.stderr.on('data', note)
  const done = new Promise<number>((resolve) => {
    child.once('error', () => resolve(1))
    child.once('close', (code) => resolve(code ?? 1))
  }).finally(() => {
    ended = true
    wake?.()
  })

  return {
    home,
    done,
    cancel: terminate,
    output: (async function* () {
      for (;;) {
        while (printed.length > 0) yield printed.shift() as string
        if (ended) return
        await new Promise<void>((resolve) => (wake = resolve))
      }
    })(),
    async discard() {
      await runtime.stop().catch(() => {})
      await rm(home, { recursive: true, force: true })
    }
  }
}

/** How long the answer to "whose container is at this address" is believed. */
const ADDRESSES_FRESH_MS = 5000

/**
 * Starts the runner's care of agent logins and puts it into every container it starts from
 * here on: a home with no real login in it, stand-ins in the environment, and the proxy's
 * name leading to the host.
 */
async function keepLogins(
  db: Database.Database,
  store: SecretStore,
  config: RunnerConfig,
  where: NonNullable<RunnerConfig['logins']>
): Promise<Logins> {
  let byAddress = new Map<string, string>()
  let readAt = 0
  const emailOf = db.prepare('SELECT email FROM users WHERE id = ?')
  const ownerOf = db.prepare('SELECT owner_id FROM workspaces WHERE id = ?')

  const logins = await startLogins({
    key: config.secretKey,
    store,
    host: where.host,
    port: where.port,
    fronts: where.fronts,
    ...(config.github === undefined ? {} : { github: config.github }),
    isAdmitted(userId) {
      if (config.devIdentities.some((identity) => identity.userId === userId)) return true
      const user = emailOf.get(userId) as { email: string } | undefined
      return user !== undefined && config.signIn?.isAdmitted(user.email) === true
    },
    // Docker is asked again for an address it has not said anything about, and at least every
    // few seconds: addresses are handed out anew as containers come and go.
    async ownerAt(address) {
      if (!byAddress.has(address) || Date.now() - readAt > ADDRESSES_FRESH_MS) {
        byAddress = await workspacesByAddress().catch(() => new Map<string, string>())
        readAt = Date.now()
      }
      const workspaceId = byAddress.get(address)
      if (workspaceId === undefined) return null
      return (ownerOf.get(workspaceId) as { owner_id: string | null } | undefined)?.owner_id ?? null
    },
    homeOf: (userId) => homeFolder(config.dataDir, userId),
    signInToCodex: () => codexSignIn(config.dataDir)
  })
  setContainerLogins(logins)
  // The runner's own clones and fetches reach GitHub as the workspace's owner.
  setRemoteAccess((ownerId) => (ownerId === null ? Promise.resolve({}) : logins.hostGitAccess(ownerId)))
  // A sign-in the last runner process was in the middle of is over: nothing can finish it now.
  await removeSignInContainers().catch(() => {})
  await rm(path.join(config.dataDir, SIGN_INS_DIR), { recursive: true, force: true })
  // Logins people made in their homes before now do not wait there for a workspace to start.
  const homes = await readdir(path.join(config.dataDir, HOMES_DIR)).catch(() => [] as string[])
  for (const userId of homes) {
    if (emailOf.get(userId) === undefined) continue
    await logins
      .secureHome(userId, homeFolder(config.dataDir, userId))
      .catch((error: unknown) => console.warn(`[loom-runner] could not secure the home of ${userId}:`, error))
  }
  return logins
}

/** Loom's services with no window: the same code the desktop runs, driven over a socket. */
export async function startRunner(config: RunnerConfig): Promise<Runner> {
  await mkdir(config.dataDir, { recursive: true })
  const db = openDb(path.join(config.dataDir, 'loom.db'))
  const secrets = createSecretStore(path.join(config.dataDir, 'secrets.enc'), aesGcmCipher(config.secretKey))
  setEnvSecretStore(secrets)
  setLoomDataRoot(config.dataDir)
  registerBackends(secrets)
  for (const identity of config.devIdentities) ensureUser(db, { id: identity.userId, email: identity.email })
  const [onlyUser] = config.devIdentities
  if (onlyUser !== undefined && config.devIdentities.length === 1) {
    // Workspaces made before owners existed: on a one-user runner they can only be that user's.
    db.prepare('UPDATE workspaces SET owner_id = ? WHERE owner_id IS NULL').run(onlyUser.userId)
  }
  const access = createAccess(db)
  const logins = config.logins === undefined ? null : await keepLogins(db, secrets, config, config.logins)
  let connectedUsers = (): string[] => []
  let closeForwards = (_id: string): void => {}
  let pushPower = (_push: WorkspacePowerPush): void => {}
  const power = createWorkspacePower({
    db,
    start: (id) => runtimeFor(getWorkspaceOrThrow(db, id), config.dataDir).ensureRunning(),
    inspect: (id) => containerIsRunning(containerName(id)),
    stop: (id) => discardRuntime(getWorkspaceOrThrow(db, id)),
    suspend(id) {
      closeForwards(id)
      suspendWorkspaceSessions(db, id)
      destroyTerminalsForCwd(getWorkspaceOrThrow(db, id).worktreePath)
    },
    changed: (push) => pushPower(push),
    connectedUsers: () => connectedUsers(),
    busyWorkspaces: () => Object.values(sessionActivity().bySession),
    idleMs: config.idleMs ?? 30 * 60_000
  })
  setRuntimePowerGate(power)
  registerRunnerHandlers(
    { db, secrets, dataRoot: config.dataDir },
    { placement: config.placement, allowLocalRemotes: config.allowLocalRemotes, access, logins, power }
  )
  keepScrollback(SCROLLBACK_CHARS)
  await recover(db)
  persistQueues(sqliteQueueStore(db))

  const signIn = config.signIn === undefined ? null : { db, isAdmitted: config.signIn.isAdmitted }
  const signInPages =
    config.signIn === undefined
      ? undefined
      : signInRoutes({
          db,
          google: config.signIn.google,
          isAdmitted: config.signIn.isAdmitted,
          domains: config.signIn.domains,
          publicUrl: config.signIn.publicUrl,
          // One host secret, a key of its own for each purpose.
          stateSecret: createHmac('sha256', config.secretKey).update('loom.sign_in.state').digest(),
          onSignInEnded: closeConnectionsOf
        })
  const pages = new Hono()
  if (signInPages !== undefined) pages.route('/', signInPages)
  if (logins?.githubRoutes !== undefined) pages.route('/', logins.githubRoutes)
  const server = await startRunnerServer({
    host: config.host,
    port: config.port,
    http: getRequestListener(pages.fetch),
    authenticate(bearer) {
      const known = config.devIdentities.find((identity) => sameSecret(bearer, identity.token))
      if (known !== undefined) return { userId: known.userId }
      return signIn === null ? null : whoHolds(signIn, bearer)
    },
    stillAllowed: (caller) =>
      caller.signInId === undefined || (signIn !== null && signInIsLive(signIn, caller.signInId)),
    async forward(caller, workspaceId, port) {
      access.assertMayCall(caller, 'workspaces:power', { workspaceId })
      const workspace = getWorkspaceOrThrow(db, workspaceId)
      if (
        workspace.runtime !== 'container' ||
        workspace.state !== 'ready' ||
        power.status(workspaceId).state !== 'running'
      )
        throw new Error('Start the cloud workspace before forwarding a port')
      return openForwardTarget(runtimeFor(workspace, config.dataDir), port)
    },
    // The same input checks as the window's calls, then: is this the caller's to touch?
    async dispatch(caller, channel, input) {
      const parsed = parseInput(channel, input)
      access.assertMayCall(caller, channel, parsed)
      const result = await call(channel, parsed, caller)
      access.noteResult(caller, channel, result)
      return result
    }
  })
  connectedUsers = () => server.connectedUsers()
  closeForwards = (id) => server.closeWorkspaceForwards(id)
  pushPower = (push) =>
    server.sendTo(access.ownerOf('workspace', push.workspaceId), WORKSPACE_POWER_CHANNEL, push)
  const idleTimer = setInterval(() => void power.sweep(), 15_000)
  idleTimer.unref()
  /** Signing out is not complete while a terminal or chat stream of that sign-in is still open. */
  function closeConnectionsOf(signInId: string): void {
    server.closeWhere((caller) => caller.signInId === signInId)
  }

  // What the desktop pushes to its window, a runner pushes to the desktops of the owner alone.
  const toOwnerOfSession = (channel: string) => (push: { sessionId: string }) =>
    server.sendTo(access.ownerOf('session', push.sessionId), channel, push)
  setSessionSink(toOwnerOfSession(SESSION_EVENT_CHANNEL))
  setQueueSink(toOwnerOfSession(SESSION_QUEUE_CHANNEL))
  setTitleSink(toOwnerOfSession(SESSION_TITLE_CHANNEL))
  setWorkspaceStateSink((push) =>
    server.sendTo(access.ownerOf('workspace', push.workspaceId), WORKSPACE_STATE_CHANNEL, push)
  )
  setTerminalSink((channel, push) => {
    server.sendTo(access.ownerOf('terminal', push.id), channel, push)
    if (channel === TERMINAL_EXIT_CHANNEL) access.forgetTerminal(push.id)
  })
  // One snapshot covers every tab; each user is sent the part that is theirs.
  setActivitySink((activity) => {
    for (const userId of server.connectedUsers()) {
      server.sendTo(userId, SESSION_ACTIVITY_CHANNEL, access.activityFor(userId, activity))
    }
  })

  return {
    port: server.port,
    async close() {
      clearInterval(idleTimer)
      await power.close()
      closeAllSessions(db)
      await server.close()
      await logins?.close()
      setContainerLogins(null)
      setRuntimePowerGate(null)
      setRemoteAccess(null)
      db.close()
    }
  }
}
