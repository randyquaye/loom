import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import type { AgentLogins, CodexSignIn, LoginAttempt } from '../../shared/ipc-contract'
import { GhNotAuthenticatedError } from '../integrations/github/errors'
import { ghWithToken, type GhExec } from '../integrations/github/gh'
import { createGithubConnect } from './github-connect'
import { githubClient, type GithubAppConfig } from './github'
import { readCodexSignIn, secureHome } from './homes'
import { startLoginProxy } from './proxy'
import { renewingVault } from './renewal'
import { standInFor, type LoginProvider } from './stand-in'
import { createLoginVault, type SealedStore } from './vault'

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
  isAdmitted(userId: string): boolean
  ownerAt(address: string): string | null | Promise<string | null>
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
  connectClaude(userId: string, token: string): Promise<void>
  connectGithub(userId: string, desktop: string): Promise<{ url: string }>
  finishGithub(userId: string, claim: string): Promise<void>
  checkGithub(userId: string): Promise<void>
  connectCodex(userId: string): Promise<CodexSignIn>
  disconnect(userId: string, provider: LoginProvider): Promise<void>
  revokeAccess(userId: string): void
  forget(userId: string): Promise<void>
  environment(userId: string): Promise<Record<string, string>>
  hostGitAccess(userId: string): Promise<Record<string, string>>
  githubExec(userId: string): Promise<GhExec>
  hosts: readonly string[]
  secureHome(userId: string, homePath: string): Promise<void>
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
}

/** One facade for Settings, host git and the container proxy. */
export async function startLogins(options: LoginsOptions): Promise<Logins> {
  const { key, fronts } = options
  const github = options.github === undefined ? undefined : githubClient(options.github)
  const kept = renewingVault(createLoginVault(options.store), github === undefined ? {} : { github })
  const securing = new Map<string, Promise<void>>()
  function secure(userId: string, homePath: string): Promise<void> {
    if (!options.isAdmitted(userId)) return Promise.resolve()
    const next = (securing.get(homePath) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (!options.isAdmitted(userId)) return
        return secureHome({
          key,
          vault: kept,
          codexUrl: fronts.codex,
          githubUrl: fronts.github,
          userId,
          homePath
        })
      })
    securing.set(homePath, next)
    void next
      .finally(() => {
        if (securing.get(homePath) === next) securing.delete(homePath)
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
          isAdmitted: options.isAdmitted,
          onConnected: (userId) => secure(userId, options.homeOf(userId)),
          onFailed: (why) => console.warn(`[loom-runner] a GitHub connection failed: ${why}`)
        })
  const proxy = await startLoginProxy({
    host: options.host,
    port: options.port,
    key,
    vault: kept,
    isAdmitted: options.isAdmitted,
    ownerAt: options.ownerAt,
    onRefused: (note) => console.warn(`[loom-runner] login proxy refused: ${note}`),
    ...(options.upstreams === undefined ? {} : { upstreams: options.upstreams })
  })
  const attempts = new Map<string, CodexAttempt>()
  const finishing = new Set<Promise<void>>()
  let closed = false
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
      const login = await readCodexSignIn(run.home)
      if (attempts.get(userId) !== attempt || !options.isAdmitted(userId)) return
      await kept.put(userId, login)
      await secure(userId, options.homeOf(userId))
      attempt.info = { ...attempt.info, state: 'connected' }
    } catch {
      attempt.info = {
        ...attempt.info,
        state: 'failed',
        message: 'Codex sign-in was not completed. Try again.'
      }
    } finally {
      await run.discard()
    }
  }
  return {
    port: proxy.port,
    ...(githubFlow === undefined ? {} : { githubRoutes: githubFlow.routes }),
    async status(userId) {
      const [claude, codex, gh] = await Promise.all([
        kept.get(userId, 'claude'),
        kept.get(userId, 'codex'),
        kept.get(userId, 'github')
      ])
      const codexAttempt = attempts.get(userId)?.info
      const githubAttempt = githubFlow?.attempt(userId)
      return {
        managed: true,
        claude: claude !== null,
        codex: codex !== null,
        github: gh?.installed === true,
        codexSigningIn: codexAttempt?.state === 'starting' || codexAttempt?.state === 'waiting',
        attempts: {
          ...(codexAttempt === undefined ? {} : { codex: codexAttempt }),
          ...(githubAttempt === undefined ? {} : { github: githubAttempt })
        },
        githubApp: {
          configured: github !== undefined,
          account: gh?.account ?? null,
          installed: gh?.installed ?? false,
          installUrl: github?.installUrl ?? null
        }
      }
    },
    async connectCodex(userId) {
      if (!options.signInToCodex) throw new Error('This runner cannot run a Codex sign-in')
      cancel(userId)
      const attempt: CodexAttempt = {
        info: { id: randomUUID(), state: 'starting', expiresAt: Date.now() + SIGN_IN_TIMEOUT_MS }
      }
      attempts.set(userId, attempt)
      try {
        const run = await options.signInToCodex(userId)
        attempt.run = run
        if (closed || attempts.get(userId) !== attempt) {
          run.cancel()
          await run.discard()
          throw new Error('Sign-in cancelled')
        }
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
        void completion.finally(() => finishing.delete(completion)).catch(() => {})
        const instructions = await codexInstructions(run)
        if (attempts.get(userId) !== attempt || ['failed', 'expired'].includes(attempt.info.state))
          throw new Error('Sign-in ended')
        if (attempt.info.state === 'starting')
          attempt.info = { ...attempt.info, ...instructions, state: 'waiting' }
        return instructions
      } catch {
        if (attempt.info.state !== 'expired')
          attempt.info = {
            ...attempt.info,
            state: 'failed',
            message: 'Could not start Codex sign-in. Try again.'
          }
        attempt.run?.cancel()
        throw new Error(attempt.info.message ?? 'Could not start Codex sign-in')
      }
    },
    async connectClaude(userId, token) {
      const accessToken = token.trim()
      if (!CLAUDE_TOKEN.test(accessToken)) throw new Error('Paste a token from claude setup-token')
      await kept.put(userId, { provider: 'claude', accessToken })
    },
    async connectGithub(userId, desktop) {
      if (!githubFlow) throw new Error('The Loom GitHub App is not configured on this runner')
      return githubFlow.begin(userId, desktop)
    },
    async finishGithub(userId, claim) {
      if (!githubFlow) throw new Error('The Loom GitHub App is not configured on this runner')
      await githubFlow.finish(userId, claim)
    },
    async checkGithub(userId) {
      const login = await kept.get(userId, 'github')
      if (github === undefined || login === null) throw new Error('Connect the Loom GitHub App first')
      const installed = await github.installed(login.accessToken)
      if ((await kept.get(userId, 'github'))?.accessToken === login.accessToken)
        await kept.put(userId, { ...login, installed })
    },
    async disconnect(userId, provider) {
      if (provider === 'codex') cancel(userId)
      if (provider === 'github') githubFlow?.cancel(userId)
      await kept.remove(userId, provider)
      await secure(userId, options.homeOf(userId))
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
      await Promise.all(
        (['claude', 'codex', 'github'] as const).map((provider) => kept.remove(userId, provider))
      )
      // A credential-file update already underway must finish before the caller deletes homes.
      await securing.get(options.homeOf(userId))?.catch(() => {})
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
    async hostGitAccess(userId) {
      const login = await kept.get(userId, 'github')
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
      const login = await kept.get(userId, 'github')
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
