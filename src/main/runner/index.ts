import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { googleClient } from '../auth/google'
import { destroyAllTerminals } from '../pty'
import { closeAllSessions } from '../sessions/service'
import { workspacePlacement } from '../workspace/placement'
import { startRunner, type RunnerConfig, type SignInConfig } from './runner'

/** Outside the 4100-9990 range the ten-port workspace blocks are allocated from. */
const DEFAULT_PORT = 3877
const TOKEN_FILE = 'runner.token'

function required(env: NodeJS.ProcessEnv, name: string, why: string): string {
  const value = env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set: ${why}`)
  return value
}

/** Until sign-in exists, a desktop proves itself with this token; it is created on first start. */
async function runnerToken(env: NodeJS.ProcessEnv, dataDir: string): Promise<string> {
  const given = env['LOOM_RUNNER_TOKEN']
  if (given !== undefined && given !== '') return given
  const file = path.join(dataDir, TOKEN_FILE)
  const existing = await readFile(file, 'utf8').catch(() => null)
  if (existing !== null && existing.trim() !== '') return existing.trim()
  const token = randomBytes(32).toString('base64url')
  await writeFile(file, `${token}\n`, { mode: 0o600 })
  return token
}

function listOf(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
}

/**
 * Sign-in is on when a Google client is configured, and then all of it must be. The client
 * secret and the pilot list are host configuration: neither is ever sent to a desktop.
 */
function readSignIn(env: NodeJS.ProcessEnv): SignInConfig | undefined {
  const clientId = env['LOOM_GOOGLE_CLIENT_ID']
  if (clientId === undefined || clientId === '') return undefined
  const pilot = new Set(
    listOf(required(env, 'LOOM_PILOT_EMAILS', 'the email addresses allowed to sign in, separated by commas'))
  )
  return {
    google: googleClient({
      clientId,
      clientSecret: required(env, 'LOOM_GOOGLE_CLIENT_SECRET', 'the secret of the Google OAuth client')
    }),
    domains: listOf(required(env, 'LOOM_SIGN_IN_DOMAINS', 'the Google Workspace domains that may sign in')),
    isAdmitted: (email) => pilot.has(email.toLowerCase()),
    publicUrl: required(env, 'LOOM_PUBLIC_URL', 'the https address people reach this runner at')
  }
}

/** Where the proxy for agent logins listens, when the host says it has one. */
const DEFAULT_LOGIN_PROXY_PORT = 3878

/** The address containers are given for each program, as the host's setup names them. */
const FRONTS = {
  claude: 'LOOM_CLAUDE_FRONT_URL',
  codex: 'LOOM_CODEX_FRONT_URL',
  github: 'LOOM_GITHUB_FRONT_URL'
} as const

/**
 * A host that puts the login proxy behind HTTPS addresses for containers names them here,
 * one for each program. Without them the runner leaves agent logins in each home folder, as
 * on a developer's own machine.
 */
function readLogins(env: NodeJS.ProcessEnv): Pick<RunnerConfig, 'logins'> {
  const given = (name: string): boolean => (env[name] ?? '') !== ''
  if (!Object.values(FRONTS).some(given)) return {}
  const front = (name: string): string => {
    const url = required(env, name, 'the https address containers reach the login proxy at for this program')
    if (!url.startsWith('https://') || new URL(url).pathname !== '/') {
      throw new Error(`${name} must be an https address with no path`)
    }
    return url.replace(/\/$/, '')
  }
  return {
    logins: {
      host: '127.0.0.1',
      port: Number(env['LOOM_LOGIN_PROXY_PORT'] ?? DEFAULT_LOGIN_PROXY_PORT),
      fronts: { claude: front(FRONTS.claude), codex: front(FRONTS.codex), github: front(FRONTS.github) }
    }
  }
}

function readGithub(env: NodeJS.ProcessEnv): Pick<RunnerConfig, 'github'> {
  const clientId = env['LOOM_GITHUB_CLIENT_ID']
  if (!clientId) return {}
  const publicUrl = required(env, 'LOOM_PUBLIC_URL', 'the GitHub App callback host')
  const parsed = new URL(publicUrl)
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  ) {
    throw new Error('LOOM_PUBLIC_URL must be an https origin')
  }
  return {
    github: {
      clientId,
      publicUrl: parsed.origin,
      clientSecret: required(env, 'LOOM_GITHUB_CLIENT_SECRET', 'the GitHub App client secret'),
      slug: required(env, 'LOOM_GITHUB_APP_SLUG', 'the GitHub App URL name')
    }
  }
}

async function readConfig(env: NodeJS.ProcessEnv): Promise<RunnerConfig> {
  const dataDir = path.resolve(
    required(env, 'LOOM_DATA_DIR', 'the folder the runner keeps checkouts, homes and its database in')
  )
  const secretKey = Buffer.from(
    required(env, 'LOOM_SECRET_KEY', 'a base64 32-byte key, for example from `openssl rand -base64 32`'),
    'base64'
  )
  if (secretKey.length !== 32) throw new Error('LOOM_SECRET_KEY must decode to exactly 32 bytes')
  await mkdir(dataDir, { recursive: true })
  const signIn = readSignIn(env)
  return {
    dataDir,
    secretKey,
    // Where nobody signs in, the one token is one user: the developer running this runner.
    devIdentities:
      signIn === undefined
        ? [{ token: await runnerToken(env, dataDir), userId: 'local', email: 'local@loom.invalid' }]
        : [],
    ...(signIn === undefined ? {} : { signIn }),
    host: env['LOOM_RUNNER_HOST'] ?? '127.0.0.1',
    port: Number(env['LOOM_RUNNER_PORT'] ?? DEFAULT_PORT),
    placement: workspacePlacement('container'),
    allowLocalRemotes: env['LOOM_RUNNER_ALLOW_LOCAL_REMOTES'] === '1',
    ...readLogins(env),
    ...readGithub(env)
  }
}

async function main(): Promise<void> {
  const config = await readConfig(process.env)
  const runner = await startRunner(config)
  console.log(`[loom-runner] listening on ws://${config.host}:${runner.port}`)
  console.log(`[loom-runner] data: ${config.dataDir}; workspaces: ${config.placement.runtime}`)
  if (config.signIn !== undefined) {
    console.log(`[loom-runner] sign-in: Google, at ${config.signIn.publicUrl}`)
  } else if (process.env['LOOM_RUNNER_TOKEN'] === undefined) {
    console.log(`[loom-runner] token file: ${path.join(config.dataDir, TOKEN_FILE)}`)
  }

  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    // A stop on purpose ends what is running here; the next start then has nothing to recover.
    closeAllSessions()
    destroyAllTerminals()
    void runner.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((error: unknown) => {
  console.error(`[loom-runner] failed to start: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
