import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Hono } from 'hono'
import type { AgentLogins, CodexSignIn, LoginAttempt } from '../../shared/ipc-contract'
import { GhNotAuthenticatedError } from '../integrations/github/errors'
import { ghWithToken, type GhExec } from '../integrations/github/gh'
import { createGithubConnect } from './github-connect'
import { githubClient, type GithubAppConfig } from './github'
import { readCodexSignIn, secureHome } from './homes'
import { LoginUnavailable, startLoginProxy, type LoginCaller } from './proxy'
import { expiryOf, renewingVault } from './renewal'
import { standInFor, type LoginProvider } from './stand-in'
import { createLoginVault, type GithubLogin, type Login, type LoginVault, type SealedStore } from './vault'
import { SubscriptionIdentityError, type Subscriptions } from '../subscriptions/repository'
import { botWorkspaceProfileName } from '../subscriptions/profiles'

export interface LoginsOptions {
  key: Buffer
  store: SealedStore
  host: string
  port: number
  /**
   * The address each program is given, on the host's TLS front: an origin of its own with no
   * path. The front puts the program's name in front of the path before the proxy sees it.
   * A shared address told apart by path does not work: Codex ignores the path.
   */
  fronts: Record<LoginProvider, string>
  github?: GithubAppConfig
  botGithub?: {
    isBot(userId: string): boolean
    login(userId: string): Promise<GithubLogin | null>
    configured(userId: string): Promise<boolean>
    remove?(userId: string, assertMayCommit?: () => void): Promise<void>
  }
  subscriptions?: Subscriptions
  validateWorkspaceProfile?(workspaceId: string): void
  isAdmitted(userId: string): boolean
  ownerAt(address: string): LoginCaller | Promise<LoginCaller>
  homeOf(userId: string): string
  upstreams?: Partial<Record<LoginProvider, string>>
  signInToCodex?(userId: string): Promise<SignInRun>
}

export interface SignInRun {
  home: string
  output: AsyncIterable<string>
  done: Promise<number>
  cancel(): void
  discard(): Promise<void>
}

export interface Logins {
  port: number
  githubRoutes?: Hono
  status(userId: string): Promise<AgentLogins>
  connectClaude(userId: string, token: string, assertMayCommit?: () => void): Promise<void>
  connectGithub(userId: string, desktop: string): Promise<{ url: string }>
  finishGithub(userId: string, claim: string): Promise<void>
  checkGithub(userId: string): Promise<void>
  connectCodex(userId: string, assertMayCommit?: () => void): Promise<CodexSignIn>
  disconnect(userId: string, provider: LoginProvider, assertMayCommit?: () => void): Promise<void>
  revokeAccess(userId: string): void
  forget(userId: string): Promise<void>
  environment(userId: string): Promise<Record<string, string>>
  workspaceHome(userId: string, workspaceId: string): string
  hostGitAccess(userId: string): Promise<Record<string, string>>
  githubExec(userId: string): Promise<GhExec>
  hosts: readonly string[]
  secureHome(userId: string, homePath: string, workspaceId?: string): Promise<void>
  close(): Promise<void>
}

const SIGN_IN_TIMEOUT_MS = 15 * 60 * 1000
const COLOURS = /\u001b\[[0-9;]*m/g
const SIGN_IN_HOSTS = /(^|\.)(openai\.com|chatgpt\.com)$/
const CLAUDE_TOKEN = /^sk-ant-[A-Za-z0-9_-]{16,}$/

async function codexInstructions(run: SignInRun): Promise<CodexSignIn> {
  let printed = ''
  for await (const chunk of run.output) {
    printed = (printed + chunk.replace(COLOURS, '')).slice(-32768)
    const url = /https:\/\/\S+/.exec(printed)?.[0]
    const code = /^\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})\s*$/m.exec(printed)?.[1]
    if (url === undefined || code === undefined) continue
    if (!SIGN_IN_HOSTS.test(new URL(url).hostname)) throw new Error('Codex named an unknown sign-in page')
    return { url, code }
  }
  throw new Error('The Codex sign-in ended before it began')
}

interface CodexAttempt {
  info: LoginAttempt
  run?: SignInRun
  timer?: ReturnType<typeof setTimeout>
  assertMayCommit?: () => void
}

/** One facade for Settings, host git and the container proxy. */
export async function startLogins(options: LoginsOptions): Promise<Logins> {
  const { key, fronts } = options
  const github = options.github === undefined ? undefined : githubClient(options.github)
  const isBot = (userId: string) => options.botGithub?.isBot(userId) === true
  const subscriptions = options.subscriptions
  const isAccount = (userId: string) => subscriptions?.isAccount(userId) === true
  const raw = createLoginVault(options.store)
  const kept = renewingVault(raw, {
    ...(github === undefined ? {} : { github }),
    guardLogin(userId, login) {
      if (!isAccount(userId) || login.provider === 'github') return () => {}
      const lifecycle = subscriptions!.guardAccount(userId)
      return () => {
        lifecycle()
        subscriptions!.assertLogin(userId, login)()
      }
    },
    guardSuccess(userId, login) {
      return isAccount(userId) && login.provider !== 'github'
        ? subscriptions!.guardRefresh(userId, login)
        : () => {}
    },
    onInvalid(userId, _provider, guard) {
      if (isAccount(userId)) subscriptions!.authFailed(userId, guard)
    }
  })
  const feedback = new WeakMap<Login, () => void>()
  function unavailable(userId: string, provider: 'claude' | 'codex', workspaceId?: string): never {
    const account = workspaceId === undefined ? null : subscriptions?.bound(userId, provider, workspaceId)
    if (account?.enabled && account.state === 'rate_limited' && account.retryAt !== null)
      throw new LoginUnavailable(
        'The assigned organization subscription is cooling down. Retry after its capacity resets.',
        429,
        account.retryAt
      )
    throw new LoginUnavailable(
      'The assigned organization subscription is unavailable. An owner can inspect it in Settings, Subscriptions.'
    )
  }
  function expired(login: Login): boolean {
    const expiry = expiryOf(login.accessToken) ?? ('expiresAt' in login ? login.expiresAt : undefined)
    return expiry !== null && expiry !== undefined && expiry <= Date.now()
  }
  // Installation tokens bypass the personal OAuth renewal and persistence paths entirely.
  const resolved: LoginVault = {
    ...kept,
    async get<P extends LoginProvider>(userId: string, provider: P, workspaceId?: string) {
      if (provider === 'github' && isBot(userId))
        return (await options.botGithub!.login(userId)) as Extract<Login, { provider: P }> | null
      if (isBot(userId)) {
        if (provider === 'github') return null
        if (subscriptions === undefined || workspaceId === undefined || !options.isAdmitted(userId))
          unavailable(userId, provider, workspaceId)
        const account = subscriptions.assigned(userId, provider, workspaceId)
        if (account === null) unavailable(userId, provider, workspaceId)
        const lifecycle = subscriptions.guardAccount(account.id)
        const login = await kept.get(account.id, provider)
        try {
          lifecycle()
        } catch {
          unavailable(userId, provider, workspaceId)
        }
        if (
          !options.isAdmitted(userId) ||
          subscriptions.assigned(userId, provider, workspaceId)?.id !== account.id
        )
          unavailable(userId, provider, workspaceId)
        if (login === null || expired(login)) unavailable(userId, provider, workspaceId)
        feedback.set(login, lifecycle)
        return login
      }
      return kept.get(userId, provider)
    }
  }
  // Formatting a stand-in needs pinned account metadata, independent of current capacity.
  const profiles: LoginVault = {
    ...resolved,
    async get<P extends LoginProvider>(userId: string, provider: P, workspaceId?: string) {
      if (!isBot(userId) || provider !== 'codex') return resolved.get(userId, provider, workspaceId)
      if (workspaceId === undefined || !options.isAdmitted(userId)) return null
      const account = subscriptions?.bound(userId, 'codex', workspaceId)
      if (account === null || account === undefined) return null
      const login = await raw.get(account.id, 'codex')
      if (
        !options.isAdmitted(userId) ||
        subscriptions?.bound(userId, 'codex', workspaceId)?.id !== account.id
      )
        return null
      return login as Extract<Login, { provider: P }> | null
    }
  }
  const securing = new Map<string, Promise<void>>()
  const securingOwners = new Map<string, string>()
  function secure(userId: string, homePath: string, workspaceId?: string): Promise<void> {
    if (!options.isAdmitted(userId) || isAccount(userId) || (isBot(userId) && workspaceId === undefined))
      return Promise.resolve()
    const next = (securing.get(homePath) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (!options.isAdmitted(userId)) return
        return secureHome({
          key,
          vault: profiles,
          codexUrl: fronts.codex,
          githubUrl: fronts.github,
          userId,
          homePath,
          ...(workspaceId === undefined ? {} : { workspaceId })
        })
      })
    securing.set(homePath, next)
    securingOwners.set(homePath, userId)
    void next
      .finally(() => {
        if (securing.get(homePath) === next) {
          securing.delete(homePath)
          securingOwners.delete(homePath)
        }
      })
      .catch(() => {})
    return next
  }
  const githubFlow =
    github === undefined || options.github === undefined
      ? undefined
      : createGithubConnect({
          publicUrl: options.github.publicUrl,
          client: github,
          vault: kept,
          isAdmitted: (userId) => options.isAdmitted(userId) && !isBot(userId),
          onConnected: (userId) => secure(userId, options.homeOf(userId)),
          onFailed: (why) => console.warn(`[loom-runner] a GitHub connection failed: ${why}`)
        })
  const proxy = await startLoginProxy({
    host: options.host,
    port: options.port,
    key,
    vault: resolved,
    isAdmitted: options.isAdmitted,
    ownerAt: options.ownerAt,
    onResponse(userId, provider, workspaceId, status, headers, login, requestPath) {
      if (!isBot(userId) || provider === 'github' || workspaceId === undefined || login === null) return
      if (status === 401 && expired(login)) return
      // Bootstrap/models/token-count endpoints can reject request shape rather than a login.
      if (
        (status === 401 || status === 429) &&
        (provider === 'codex'
          ? requestPath !== '/backend-api/codex/responses'
          : !requestPath.startsWith('/v1/messages') || requestPath.startsWith('/v1/messages/count_tokens'))
      )
        return
      const lifecycle = feedback.get(login)
      if (lifecycle !== undefined)
        subscriptions?.observe(userId, provider, workspaceId, status, headers, lifecycle)
    },
    onRefused: (note) => console.warn(`[loom-runner] login proxy refused: ${note}`),
    ...(options.upstreams === undefined ? {} : { upstreams: options.upstreams })
  })
  const attempts = new Map<string, CodexAttempt>()
  const finishing = new Set<Promise<void>>()
  let closed = false
  function connectGuard(userId: string, assertMayCommit?: () => void): () => void {
    if (isBot(userId)) throw new Error('Connect provider accounts in organization Subscriptions')
    const lifecycle = isAccount(userId) ? subscriptions!.guardAccount(userId) : undefined
    const assertCurrent = () => {
      assertMayCommit?.()
      if (lifecycle !== undefined) lifecycle()
      else if (!options.isAdmitted(userId)) throw new Error('An active membership is required')
    }
    assertCurrent()
    return assertCurrent
  }
  function publicationGuard(userId: string, login: Login, guard: () => void): () => void {
    guard()
    const claim =
      isAccount(userId) && login.provider !== 'github' ? subscriptions!.assertLogin(userId, login) : undefined
    return () => {
      guard()
      claim?.()
    }
  }
  function cancel(userId: string): void {
    const previous = attempts.get(userId)
    attempts.delete(userId)
    clearTimeout(previous?.timer)
    previous?.run?.cancel()
  }
  async function finish(userId: string, attempt: CodexAttempt, run: SignInRun, code: number): Promise<void> {
    clearTimeout(attempt.timer)
    try {
      if (closed || attempts.get(userId) !== attempt || attempt.info.state === 'expired') return
      if (code !== 0) throw new Error('Codex sign-in was not completed')
      const assertCurrent = () => {
        if (
          closed ||
          attempts.get(userId) !== attempt ||
          attempt.info.state === 'expired' ||
          (!isAccount(userId) && !options.isAdmitted(userId))
        )
          throw new Error('Codex sign-in is no longer authorized')
        attempt.assertMayCommit?.()
      }
      assertCurrent()
      const login = await readCodexSignIn(run.home)
      assertCurrent()
      await kept.put(userId, login, publicationGuard(userId, login, assertCurrent))
      assertCurrent()
      if (isAccount(userId)) subscriptions!.connected(userId, login)
      await secure(userId, options.homeOf(userId))
      attempt.info = { ...attempt.info, state: 'connected' }
    } catch (error) {
      attempt.info = {
        ...attempt.info,
        state: 'failed',
        message:
          error instanceof SubscriptionIdentityError
            ? error.message
            : 'Codex sign-in was not completed. Try again.'
      }
    } finally {
      await run.discard()
    }
  }
  return {
    port: proxy.port,
    ...(githubFlow === undefined ? {} : { githubRoutes: githubFlow.routes }),
    async status(userId) {
      const bot = isBot(userId)
      const statusVault = isAccount(userId) ? raw : kept
      const [claude, codex, gh] = await Promise.all([
        bot ? null : statusVault.get(userId, 'claude'),
        bot ? null : statusVault.get(userId, 'codex'),
        resolved.get(userId, 'github')
      ])
      const codexAttempt = attempts.get(userId)?.info
      const githubAttempt = githubFlow?.attempt(userId)
      return {
        managed: true,
        claude: bot ? subscriptions?.available(userId, 'claude') === true : claude !== null,
        codex: bot ? subscriptions?.available(userId, 'codex') === true : codex !== null,
        github: gh?.installed === true,
        codexSigningIn: codexAttempt?.state === 'starting' || codexAttempt?.state === 'waiting',
        attempts: {
          ...(codexAttempt === undefined ? {} : { codex: codexAttempt }),
          ...(githubAttempt === undefined ? {} : { github: githubAttempt })
        },
        githubApp: {
          configured: isBot(userId) ? await options.botGithub!.configured(userId) : github !== undefined,
          account: gh?.account ?? null,
          installed: gh?.installed ?? false,
          installUrl: isBot(userId) ? null : (github?.installUrl ?? null)
        }
      }
    },
    async connectCodex(userId, assertMayCommit) {
      const assertCurrent = connectGuard(userId, assertMayCommit)
      if (!options.signInToCodex) throw new Error('This runner cannot run a Codex sign-in')
      cancel(userId)
      const attempt: CodexAttempt = {
        info: { id: randomUUID(), state: 'starting', expiresAt: Date.now() + SIGN_IN_TIMEOUT_MS },
        assertMayCommit: assertCurrent
      }
      attempts.set(userId, attempt)
      let finishingRun = false
      try {
        const run = await options.signInToCodex(userId)
        attempt.run = run
        if (closed || attempts.get(userId) !== attempt) {
          throw new Error('Sign-in cancelled')
        }
        assertCurrent()
        attempt.timer = setTimeout(() => {
          attempt.info = { ...attempt.info, state: 'expired', message: 'Codex sign-in expired. Try again.' }
          run.cancel()
        }, SIGN_IN_TIMEOUT_MS)
        attempt.timer.unref()
        const completion = run.done.then(
          (code) => finish(userId, attempt, run, code),
          () => finish(userId, attempt, run, 1)
        )
        finishing.add(completion)
        finishingRun = true
        void completion.finally(() => finishing.delete(completion)).catch(() => {})
        const instructions = await codexInstructions(run)
        if (attempts.get(userId) === attempt && attempt.info.state === 'connected') return instructions
        assertCurrent()
        if (attempts.get(userId) !== attempt || ['failed', 'expired'].includes(attempt.info.state))
          throw new Error('Sign-in ended')
        if (attempt.info.state === 'starting')
          attempt.info = { ...attempt.info, ...instructions, state: 'waiting' }
        return instructions
      } catch (error) {
        if (attempt.info.state !== 'expired')
          attempt.info = {
            ...attempt.info,
            state: 'failed',
            message:
              error instanceof SubscriptionIdentityError
                ? error.message
                : (attempt.info.message ?? 'Could not start Codex sign-in. Try again.')
          }
        attempt.run?.cancel()
        if (!finishingRun) await attempt.run?.discard()
        throw new Error(attempt.info.message ?? 'Could not start Codex sign-in')
      }
    },
    async connectClaude(userId, token, assertMayCommit) {
      const assertCurrent = connectGuard(userId, assertMayCommit)
      const accessToken = token.trim()
      if (!CLAUDE_TOKEN.test(accessToken)) throw new Error('Paste a token from claude setup-token')
      const login = { provider: 'claude' as const, accessToken }
      await kept.put(userId, login, publicationGuard(userId, login, assertCurrent))
      assertCurrent()
      if (isAccount(userId)) subscriptions!.connected(userId, login)
    },
    async connectGithub(userId, desktop) {
      if (isBot(userId)) throw new Error('Connect a GitHub installation for the bot instead')
      if (!githubFlow) throw new Error('The Loom GitHub App is not configured on this runner')
      return githubFlow.begin(userId, desktop)
    },
    async finishGithub(userId, claim) {
      if (isBot(userId)) throw new Error('Connect a GitHub installation for the bot instead')
      if (!githubFlow) throw new Error('The Loom GitHub App is not configured on this runner')
      await githubFlow.finish(userId, claim)
    },
    async checkGithub(userId) {
      if (isBot(userId)) {
        if ((await resolved.get(userId, 'github')) === null)
          throw new Error('Connect the bot GitHub installation first')
        return
      }
      const login = await kept.get(userId, 'github')
      if (github === undefined || login === null) throw new Error('Connect the Loom GitHub App first')
      const installed = await github.installed(login.accessToken)
      if ((await kept.get(userId, 'github'))?.accessToken === login.accessToken)
        await kept.put(userId, { ...login, installed })
    },
    async disconnect(userId, provider, assertMayCommit) {
      assertMayCommit?.()
      const bot = isBot(userId)
      if (bot && provider !== 'github')
        throw new Error('Manage provider accounts in organization Subscriptions')
      const account = isAccount(userId)
      if (bot) proxy.closeFor(userId)
      if (provider === 'codex') cancel(userId)
      if (provider === 'github') githubFlow?.cancel(userId)
      if (provider === 'github' && bot) {
        if (assertMayCommit === undefined) await options.botGithub!.remove?.(userId)
        else await options.botGithub!.remove?.(userId, assertMayCommit)
      }
      await kept.remove(userId, provider, assertMayCommit)
      assertMayCommit?.()
      if (account) subscriptions!.disconnected(userId)
      await secure(userId, options.homeOf(userId))
      if (bot) proxy.closeFor(userId)
    },
    revokeAccess(userId) {
      cancel(userId)
      githubFlow?.cancel(userId)
      proxy.closeFor(userId)
    },
    async forget(userId) {
      cancel(userId)
      githubFlow?.cancel(userId)
      proxy.closeFor(userId)
      if (isBot(userId)) await options.botGithub!.remove?.(userId)
      await Promise.all(
        (['claude', 'codex', 'github'] as const).map((provider) => kept.remove(userId, provider))
      )
      // A credential-file update already underway must finish before the caller deletes homes.
      await Promise.all(
        [...securing]
          .filter(([home]) => securingOwners.get(home) === userId)
          .map(([, pending]) => pending.catch(() => {}))
      )
    },
    async environment(userId) {
      return {
        ANTHROPIC_BASE_URL: fronts.claude,
        CLAUDE_CODE_OAUTH_TOKEN: standInFor(key, userId, 'claude'),
        GH_HOST: new URL(fronts.github).host,
        GH_ENTERPRISE_TOKEN: standInFor(key, userId, 'github'),
        GH_PROMPT_DISABLED: '1'
      }
    },
    workspaceHome(userId, workspaceId) {
      if (!isBot(userId)) return options.homeOf(userId)
      const profile = botWorkspaceProfileName(workspaceId)
      options.validateWorkspaceProfile?.(workspaceId)
      return path.join(path.dirname(options.homeOf(userId)), profile)
    },
    async hostGitAccess(userId) {
      const login = await resolved.get(userId, 'github')
      // SSH remotes must use the same App access as HTTPS, never a host SSH agent.
      const base = {
        GIT_CONFIG_COUNT: '3',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
        GIT_CONFIG_VALUE_1: 'git@github.com:',
        GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
        GIT_CONFIG_VALUE_2: 'ssh://git@github.com/'
      }
      if (login === null || !login.installed) return base
      return {
        ...base,
        GIT_CONFIG_COUNT: '4',
        GIT_CONFIG_KEY_3: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_3: `Authorization: Basic ${Buffer.from(`x-access-token:${login.accessToken}`).toString('base64')}`
      }
    },
    async githubExec(userId) {
      const login = await resolved.get(userId, 'github')
      if (login === null || !login.installed)
        throw new GhNotAuthenticatedError('Connect GitHub in Settings, Integrations, Cloud')
      return ghWithToken(login.accessToken)
    },
    hosts: [...new Set(Object.values(fronts).map((url) => `${new URL(url).hostname}:host-gateway`))],
    secureHome: secure,
    async close() {
      closed = true
      for (const user of attempts.keys()) cancel(user)
      githubFlow?.close()
      await Promise.allSettled(finishing)
      await proxy.close()
    }
  }
}
