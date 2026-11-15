import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import type Database from 'better-sqlite3'
import {
  BOTS_CHANGED_CHANNEL,
  SESSION_ACTIVITY_CHANNEL,
  SESSION_EVENT_CHANNEL,
  SESSION_QUEUE_CHANNEL,
  SESSION_TITLE_CHANNEL,
  TERMINAL_EXIT_CHANNEL,
  WORKSPACE_STATE_CHANNEL,
  WORKSPACE_POWER_CHANNEL,
  type SessionActivity,
  type WorkspacePowerPush
} from '../../shared/ipc-contract'
import { NOTIFICATION_CHANNEL, type Notification } from '../../shared/notifications'
import { RUNNER_CAPABILITIES, supportsBots } from '../../shared/runner-capabilities'
import { registerBackends } from '../agents/wiring'
import { setCodexQuotaObserver } from '../agents/cli/codex-session'
import type { GoogleClient } from '../auth/google'
import { createHostProof } from '../auth/host-proof'
import { signInRoutes } from '../auth/routes'
import { signInIsLive, whoHolds } from '../auth/tokens'
import { openDb } from '../db'
import { ensureUser } from '../db/repos/users'
import { createOrgService } from '../org/service'
import { createBotService, readBot } from '../bots/repository'
import { createBotGithub, type BotGithub } from '../bots/github'
import { createBotExecution } from '../bots/execution'
import { createBotInvocations } from '../bots/invocations'
import { createBotQuiescence } from '../bots/quiescence'
import { registerBotHandlers } from '../bots/handlers'
import { createSubscriptions, type Subscriptions } from '../subscriptions/repository'
import { registerSubscriptionHandlers } from '../subscriptions/handlers'
import { assertBotProfileAvailable } from '../subscriptions/profiles'
import { botRepositoryUrl, canonicalBotRepository } from '../../shared/bots'
import { CALL_SUBJECTS } from '../../shared/call-subjects'
import { getProjectOrThrow } from '../db/repos/projects'
import { setEnvSecretStore } from '../env/vars'
import { call, parseInput } from '../ipc/registry'
import { createNotifications } from '../notifications/service'
import { destroyTerminalsForCwd, keepScrollback, listTerminals, setTerminalSink, terminalIoAt } from '../pty'
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
  setTurnStartGuard,
  sessionActivity,
  stopSessionWork,
  suspendWorkspaceSessions
} from '../sessions/service'
import { setRemoteAccess, setWorkspaceStateSink } from '../workspace/bootstrap'
import type { WorkspacePlacement } from '../workspace/placement'
import { createIdlePrompts } from '../workspace/idle-prompt'
import { createWorkspacePower } from '../workspace/power'
import { getWorkspaceOrThrow } from '../db/repos/workspaces'
import { openForwardTarget } from '../runtime/forward'
import { containerIsRunning } from '../runtime/container'
import { createAccess } from './access'
import { createRunnerGit } from './git'
import { ensureProject, registerRunnerHandlers } from './handlers'
import { sameSecret, startRunnerServer } from './server'
import { createRunnerAdmission } from './admission'
import { cloudHealth } from './health'
import { runnerOperations } from './operations'
import { createMemberCleanup } from './members'
import { createTransportProofReader } from './transport'

/**
 * A stand-in for sign-in: whoever presents the token is that user. For a runner on a
 * developer's own machine and for tests; a host where people sign in has none.
 */
export interface DevIdentity {
  token: string
  userId: string
  email: string
}

/** Google proves identity; active membership decides admission. */
export interface SignInConfig {
  google: GoogleClient
  /** Google Workspace domains whose accounts may sign in at all. */
  domains: string[]
  ownerEmail: string
  googleClientId: string
  signingKey: string
  transportProofFile: string
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
  maxRunningWorkspaces?: number
  minFreeDiskBytes?: number
  operatorToken?: string
  downloadDir?: string
  release?: string
}

export interface Runner {
  readonly port: number
  /** Stops listening and retires this process's sessions. Persisted turns recover on restart. */
  close(): Promise<void>
}

const SCROLLBACK_CHARS = 256 * 1024
const ACCEPTED_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const NEW_WORK_CALLS = new Set([
  'workspaces:add',
  'workspaces:start',
  'workspaces:runAction',
  'terminal:create',
  'sessions:create',
  'sessions:fork',
  'sessions:send',
  'sessions:sendNow',
  'sessions:steer',
  'sessions:steerQueued',
  'bots:invoke'
])

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

/**
 * Starts the runner's care of agent logins and puts it into every container it starts from
 * here on: a home with no real login in it, stand-ins in the environment, and the proxy's
 * name leading to the host.
 */
async function keepLogins(
  db: Database.Database,
  store: SecretStore,
  config: RunnerConfig,
  where: NonNullable<RunnerConfig['logins']>,
  isAdmitted: (userId: string) => boolean,
  botGithub?: BotGithub,
  isBot?: (userId: string) => boolean,
  subscriptions?: Subscriptions
): Promise<Logins> {
  const emailOf = db.prepare('SELECT email FROM users WHERE id = ?')
  const ownerOf = db.prepare('SELECT owner_id FROM workspaces WHERE id = ?')

  const logins = await startLogins({
    key: config.secretKey,
    store,
    host: where.host,
    port: where.port,
    fronts: where.fronts,
    ...(config.github === undefined ? {} : { github: config.github }),
    isAdmitted,
    ...(botGithub === undefined || isBot === undefined ? {} : { botGithub: { ...botGithub, isBot } }),
    ...(subscriptions === undefined ? {} : { subscriptions }),
    validateWorkspaceProfile: (workspaceId) => assertBotProfileAvailable(db, workspaceId),
    // Resolve each admission from Docker again, including after a credential await:
    // an address can already belong to another member's newly started container.
    async ownerAt(address) {
      const byAddress = await workspacesByAddress().catch(() => null)
      if (byAddress === null) return null
      const workspaceId = byAddress.get(address)
      if (workspaceId === undefined) return null
      const userId = (ownerOf.get(workspaceId) as { owner_id: string | null } | undefined)?.owner_id ?? null
      return userId !== null && isBot?.(userId) === true ? { userId, workspaceId } : userId
    },
    homeOf: (userId) => homeFolder(config.dataDir, userId),
    signInToCodex: () => codexSignIn(config.dataDir)
  })
  setContainerLogins(logins)
  // The runner's own clones and fetches reach GitHub as the workspace's owner.
  setRemoteAccess(async (ownerId) => {
    if (ownerId === null || !isAdmitted(ownerId)) throw new Error('An active membership is required')
    const access = await logins.hostGitAccess(ownerId)
    if (!isAdmitted(ownerId)) throw new Error('An active membership is required')
    return access
  })
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
  const gitBoundary = createRunnerGit({ db, dataRoot: config.dataDir })
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
  const org = config.signIn === undefined ? null : createOrgService(db, config.signIn)
  const bots = org === null ? null : createBotService({ db, org })
  const initialBotIds = (
    db.prepare("SELECT user_id AS userId FROM org_members WHERE kind='bot'").all() as Array<{
      userId: string
    }>
  ).map((row) => row.userId)
  // The proxy starts before recovery; old bot containers must remain unauthorized throughout.
  const blockedBots = new Set(initialBotIds)
  const membershipKind = db.prepare('SELECT kind FROM org_members WHERE user_id=?')
  const isBot = (userId: string) =>
    (membershipKind.get(userId) as { kind: string } | undefined)?.kind === 'bot'
  const subscriptions = org === null ? null : createSubscriptions({ db, org, isBot })
  const transportProof =
    config.signIn === undefined
      ? () => null
      : createTransportProofReader(
          config.signIn.transportProofFile,
          config.signIn.publicUrl,
          config.signIn.signingKey
        )
  const isAdmitted = (userId: string) =>
    !blockedBots.has(userId) &&
    (config.devIdentities.some((identity) => identity.userId === userId) ||
      (org?.active(userId) === true && (!isBot(userId) || readBot(db, userId)?.enabled === true)))
  const access = createAccess(db, (userId) => org?.owner(userId) === true)
  const admission = createRunnerAdmission({
    db,
    isAdmitted,
    maxRunning: config.maxRunningWorkspaces ?? Number.MAX_SAFE_INTEGER,
    minFreeBytes: config.minFreeDiskBytes ?? 0,
    available: async () => (await cloudHealth(config.dataDir)).disk.available
  })
  let logins: Logins | null = null
  const botGithub = createBotGithub({
    store: secrets,
    isAdmitted,
    isBot,
    repositories: (id) => readBot(db, id)?.config.repositories ?? [],
    onRevoked: (id) => logins?.revokeAccess(id)
  })
  logins =
    config.logins === undefined
      ? null
      : await keepLogins(
          db,
          secrets,
          config,
          config.logins,
          isAdmitted,
          botGithub,
          isBot,
          subscriptions ?? undefined
        )
  let ready = false
  let connectedUsers = (): string[] => []
  let forwardedWorkspaces = (): string[] => []
  let closeForwards = (_id: string): void => {}
  let pushPower = (_push: WorkspacePowerPush): void => {}
  let pushNotification = (_notification: Notification): void => {}
  const notifications = createNotifications({ db, changed: (notification) => pushNotification(notification) })
  const idle = createIdlePrompts({
    notifications,
    ownerOf: (id) => access.ownerOf('workspace', id),
    isConnected: (userId) => connectedUsers().includes(userId),
    keep: (id) => power.keep(id),
    stop: (id) => power.stop(id)
  })
  const power = createWorkspacePower({
    db,
    admitStart: admission.start,
    start: (id) => runtimeFor(getWorkspaceOrThrow(db, id), config.dataDir).ensureRunning(),
    inspect: (id) => containerIsRunning(containerName(id)),
    stop: (id) => discardRuntime(getWorkspaceOrThrow(db, id)),
    suspend(id) {
      closeForwards(id)
      suspendWorkspaceSessions(db, id)
      destroyTerminalsForCwd(getWorkspaceOrThrow(db, id).worktreePath)
    },
    changed(push) {
      pushPower(push)
      if (push.state === 'stopped' || push.state === 'error') idle.stopped(push.workspaceId)
    },
    signals: {
      busyWorkspaces: () => Object.values(sessionActivity().bySession),
      terminalIoAt: (id) => terminalIoAt(getWorkspaceOrThrow(db, id).worktreePath),
      forwardedWorkspaces: () => forwardedWorkspaces(),
      runningCommand: (id) => runtimeFor(getWorkspaceOrThrow(db, id), config.dataDir).runningCommand()
    },
    prompts: idle,
    idleMs: config.idleMs ?? 30 * 60_000
  })
  setRuntimePowerGate({
    ...power,
    assertRunning(id) {
      admission.assertWorkspace(id)
      power.assertRunning(id)
    },
    beforeStart(id) {
      admission.assertWorkspace(id)
      power.beforeStart(id)
    },
    afterStart(id) {
      admission.assertWorkspace(id)
      power.afterStart(id)
    }
  })
  setTurnStartGuard((id, actorId) => {
    const workspace = getWorkspaceOrThrow(db, id)
    const owner = workspace.ownerId
    if (owner === null) throw new Error('Workspace has no member owner')
    admission.assertNewWork(owner)
    if (isBot(owner)) {
      const bot = bots?.assertControl(actorId ?? '', owner)
      const repository = canonicalBotRepository(getProjectOrThrow(db, workspace.projectId).remoteUrl ?? '')
      if (!bot?.config.repositories.includes(repository)) throw new Error('Bot repository access was revoked')
      const session = db
        .prepare('SELECT backend FROM sessions WHERE workspace_id=? ORDER BY created_at,id LIMIT 1')
        .get(id) as { backend: string } | undefined
      if (
        (session?.backend !== 'claude' && session?.backend !== 'codex') ||
        subscriptions === null ||
        subscriptions.assigned(owner, session.backend, id) === null
      )
        throw new Error(
          'This bot conversation has no available organization subscription. Inspect its assigned account or start a new bot task.'
        )
    }
  })
  setCodexQuotaObserver((workspaceId) => {
    if (subscriptions === null) return
    const workspace = getWorkspaceOrThrow(db, workspaceId)
    const owner = workspace.ownerId
    if (owner === null || !isBot(owner)) return
    const account = subscriptions.assigned(owner, 'codex', workspaceId)
    if (account === null) return
    const assertCurrent = subscriptions.guardAccount(account.id)
    return ({ resetAt }) => {
      if (!ready || !db.open || !isAdmitted(owner)) return
      const binding = db
        .prepare(
          'SELECT account_id AS accountId FROM subscription_bindings WHERE workspace_id=? AND provider=? AND bot_id=?'
        )
        .get(workspaceId, 'codex', owner) as { accountId: string } | undefined
      if (binding?.accountId !== account.id) return
      const headers =
        resetAt !== null && Number.isFinite(resetAt) && resetAt > Date.now()
          ? { 'x-ratelimit-reset': String(resetAt / 1000) }
          : {}
      subscriptions.observe(owner, 'codex', workspaceId, 429, headers, assertCurrent)
    }
  })
  const cleanup = createMemberCleanup({
    db,
    org,
    secrets,
    logins,
    power,
    dataDir: config.dataDir,
    closeConnections: (userId) => server.closeWhere((caller) => caller.userId === userId)
  })
  registerRunnerHandlers(
    { db, secrets, dataRoot: config.dataDir },
    {
      placement: config.placement,
      allowLocalRemotes: config.allowLocalRemotes,
      access,
      logins,
      power,
      notifications,
      org,
      admission,
      signIn: config.signIn,
      async removeMember(actorId, userId) {
        const affected = db
          .prepare('SELECT bot_id AS botId FROM bot_grants WHERE user_id = ?')
          .all(userId) as Array<{ botId: string }>
        try {
          await cleanup.remove(actorId, userId)
        } finally {
          for (const { botId } of affected) await botsChanged(botId, true)
          if (isBot(userId)) await botsChanged(userId, true)
        }
      },
      purgeMember: cleanup.purgeMember
    }
  )
  const execution = createBotExecution({
    db,
    dataRoot: config.dataDir,
    admission,
    projectFor: (repository) =>
      ensureProject(db, { name: repository.split('/')[1]!, remoteUrl: botRepositoryUrl(repository) }, false),
    async credentialsReady(botId, settings, workspaceId) {
      if (logins === null || subscriptions === null)
        throw new Error('Bot execution requires organization subscriptions')
      const status = await logins.status(botId)
      if (!status[settings.backend])
        throw new Error(
          `Grant this bot organization ${settings.backend} subscriptions and connect an eligible account`
        )
      if (!status.github) throw new Error('Connect the bot GitHub installation and repository grants first')
      subscriptions.reserve(botId, settings.backend, workspaceId)
    }
  })
  const invocations =
    bots === null
      ? null
      : createBotInvocations({
          db,
          bots,
          provision: execution.provision,
          changed: (botId) => {
            void botsChanged(botId, false).catch((error: unknown) =>
              console.warn('[loom-runner] bot cleanup remains blocked:', error)
            )
          }
        })
  const audiences = new Map<string, Set<string>>()
  for (const row of db.prepare('SELECT bot_id AS botId,user_id AS userId FROM bot_grants').all() as Array<{
    botId: string
    userId: string
  }>) {
    const audience = audiences.get(row.botId) ?? new Set<string>()
    audience.add(row.userId)
    audiences.set(row.botId, audience)
  }
  const quiescence = createBotQuiescence({
    db,
    blocked: blockedBots,
    interrupt: (botId) =>
      invocations?.interrupt(
        botId,
        'Bot access or credentials changed. Inspect retained work before explicitly continuing.'
      ),
    revokeCredentials: (botId) => botGithub.invalidate(botId),
    closeForwards: (workspaceId) => closeForwards(workspaceId),
    stopSession: (sessionId) => stopSessionWork(db, sessionId),
    stopTerminals: (workspaceId) => destroyTerminalsForCwd(getWorkspaceOrThrow(db, workspaceId).worktreePath),
    stopWorkspace: (workspaceId) => power.stopForRemoval(workspaceId)
  })
  async function botsChanged(botId: string, stop: boolean): Promise<void> {
    const previous = audiences.get(botId) ?? new Set<string>()
    const next = new Set(
      (
        db.prepare('SELECT user_id AS userId FROM bot_grants WHERE bot_id = ?').all(botId) as Array<{
          userId: string
        }>
      ).map((row) => row.userId)
    )
    audiences.set(botId, next)
    return quiescence.change(botId, stop, () => {
      for (const userId of connectedUsers()) {
        if (org?.owner(userId) || previous.has(userId) || next.has(userId))
          server.sendTo(userId, BOTS_CHANGED_CHANNEL, {
            botId,
            accessChanged: stop || previous.has(userId) !== next.has(userId)
          })
      }
    })
  }
  if (bots !== null && org !== null && invocations !== null)
    registerBotHandlers({
      db,
      bots,
      org,
      invocations,
      github: botGithub,
      logins,
      access,
      changed: botsChanged
    })
  if (subscriptions !== null && org !== null)
    registerSubscriptionHandlers({ db, org, subscriptions, logins, changed: botsChanged })
  keepScrollback(SCROLLBACK_CHARS)
  await recover(db)
  quiescence.releaseRecovered(initialBotIds)
  invocations?.recover()
  idle.stoppedAll()
  persistQueues(sqliteQueueStore(db))

  const signIn = config.signIn === undefined ? null : { db, isAdmitted }
  const signInPages =
    config.signIn === undefined
      ? undefined
      : signInRoutes({
          db,
          google: config.signIn.google,
          isAdmitted,
          ...(org === null ? {} : { org }),
          hostProof: (nonce) => createHostProof(config.signIn!.signingKey, config.signIn!.publicUrl, nonce),
          transportProof,
          domains: config.signIn.domains,
          publicUrl: config.signIn.publicUrl,
          // One host secret, a key of its own for each purpose.
          stateSecret: createHmac('sha256', config.secretKey).update('loom.sign_in.state').digest(),
          onSignInEnded: closeConnectionsOf
        })
  const pages = new Hono()
  if (signInPages !== undefined) pages.route('/', signInPages)
  if (logins?.githubRoutes !== undefined) pages.route('/', logins.githubRoutes)
  pages.route(
    '/',
    runnerOperations({
      ...(config.downloadDir === undefined ? {} : { downloadDir: config.downloadDir }),
      release: config.release ?? 'development',
      ready: () =>
        ready && !admission.draining() && (config.signIn === undefined || transportProof() !== null),
      setDraining: admission.setDraining,
      status: () => {
        const workspaces = db.prepare('SELECT id, worktree_path, state FROM workspaces').all() as Array<{
          id: string
          worktree_path: string
          state: string
        }>
        return {
          draining: admission.draining(),
          activeTurns: Object.entries(sessionActivity().bySession).map(([sessionId, workspaceId]) => ({
            sessionId,
            workspaceId
          })),
          terminals: workspaces.flatMap((workspace) => {
            const count = listTerminals(workspace.worktree_path).length
            return count === 0 ? [] : [{ workspaceId: workspace.id, count }]
          }),
          forwards: forwardedWorkspaces(),
          setup: workspaces
            .filter((workspace) => ['initializing', 'setting_up'].includes(workspace.state))
            .map((workspace) => workspace.id)
        }
      },
      authorized(token) {
        if (config.operatorToken !== undefined && sameSecret(token, config.operatorToken)) return true
        const caller = signIn === null ? null : whoHolds(signIn, token)
        return caller !== null && org?.owner(caller.userId) === true
      }
    })
  )
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
    mayForward: (caller, workspaceId) =>
      isAdmitted(caller.userId) &&
      access.mayControlWorkspace(caller.userId, workspaceId, caller.capabilities),
    pushFor(caller, channel, payload, workspaceId) {
      if (supportsBots(caller.capabilities ?? RUNNER_CAPABILITIES)) return payload
      if (channel.startsWith('bots:') || (workspaceId !== undefined && access.isBotWorkspace(workspaceId)))
        return undefined
      return channel === SESSION_ACTIVITY_CHANNEL
        ? access.activityFor(caller.userId, payload as SessionActivity, [])
        : payload
    },
    async forward(caller, workspaceId, port) {
      access.assertMayCall(caller, 'ports:forward', { workspaceId, port })
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
      admission.assertMember(caller.userId)
      access.assertMayCall(caller, channel, parsed)
      if (NEW_WORK_CALLS.has(channel)) admission.assertNewWork(caller.userId)
      const result = await call(channel, parsed, caller)
      admission.assertMember(caller.userId)
      if (
        (channel in CALL_SUBJECTS || channel === 'files:upload') &&
        !['workspaces:remove', 'terminal:destroy', 'comments:remove'].includes(channel)
      )
        access.assertMayCall(caller, channel, parsed)
      if (channel === 'bots:open')
        invocations?.get(caller.userId, (parsed as { invocationId: string }).invocationId)
      access.noteResult(caller, channel, result, parsed)
      return result
    }
  })
  connectedUsers = () => server.connectedUsers()
  forwardedWorkspaces = () => server.forwardedWorkspaces()
  pushNotification = (notification) => server.sendTo(notification.ownerId, NOTIFICATION_CHANNEL, notification)
  closeForwards = (id) => server.closeWorkspaceForwards(id)
  const toWorkspace = (workspaceId: string, channel: string, payload: unknown): void => {
    for (const userId of access.viewers(workspaceId)) server.sendTo(userId, channel, payload, workspaceId)
  }
  pushPower = (push) => toWorkspace(push.workspaceId, WORKSPACE_POWER_CHANNEL, push)
  const idleTimer = setInterval(() => void power.sweep(), 15_000)
  idleTimer.unref()
  const cleanupTimer = setInterval(() => void cleanup.sweep(), 24 * 60 * 60_000)
  cleanupTimer.unref()
  await cleanup.sweep()
  ready = true
  /** Signing out is not complete while a terminal or chat stream of that sign-in is still open. */
  function closeConnectionsOf(signInId: string): void {
    server.closeWhere((caller) => caller.signInId === signInId)
  }

  // What the desktop pushes to its window, a runner pushes to the desktops of the owner alone.
  const toOwnerOfSession = (channel: string) => (push: { sessionId: string }) => {
    const workspaceId = access.workspaceOf('session', push.sessionId)
    if (workspaceId !== null) toWorkspace(workspaceId, channel, { ...push, workspaceId })
  }
  setSessionSink(toOwnerOfSession(SESSION_EVENT_CHANNEL))
  setQueueSink(toOwnerOfSession(SESSION_QUEUE_CHANNEL))
  setTitleSink(toOwnerOfSession(SESSION_TITLE_CHANNEL))
  setWorkspaceStateSink((push) => toWorkspace(push.workspaceId, WORKSPACE_STATE_CHANNEL, push))
  setTerminalSink((channel, push) => {
    const workspaceId = access.workspaceOf('terminal', push.id)
    if (workspaceId !== null && isBot(access.ownerOf('workspace', workspaceId) ?? ''))
      toWorkspace(workspaceId, channel, push)
    else server.sendTo(access.ownerOf('terminal', push.id), channel, push)
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
      ready = false
      admission.setDraining(true)
      clearInterval(idleTimer)
      clearInterval(cleanupTimer)
      await admission.close()
      await invocations?.close()
      await quiescence.idle()
      await cleanup.close()
      await power.close()
      closeAllSessions(db)
      await server.close()
      await logins?.close()
      setContainerLogins(null)
      setRuntimePowerGate(null)
      setTurnStartGuard(null)
      setCodexQuotaObserver(null)
      setRemoteAccess(null)
      // A later runner in this process must not invoke closures holding this closed database.
      setSessionSink(() => {})
      setQueueSink(() => {})
      setTitleSink(() => {})
      setActivitySink(() => {})
      setWorkspaceStateSink(() => {})
      setTerminalSink(() => {})
      gitBoundary.close()
      db.close()
    }
  }
}
