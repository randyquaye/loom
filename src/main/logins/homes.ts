import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { LOGIN_FILES } from '../../shared/login-files'
import { standInFor } from './stand-in'
import type { CodexLogin, LoginVault } from './vault'

export interface HomeToSecure {
  key: Buffer
  vault: LoginVault
  /** Codex's own address on the host's TLS front. */
  codexUrl: string
  /** The address that stands for GitHub inside containers: git and gh are pointed at it. */
  githubUrl: string
  userId: string
  homePath: string
}

/** A ChatGPT sign-in as Codex keeps it in a home folder. */
const codexFile = z.object({
  tokens: z.object({
    id_token: z.string().min(1),
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    account_id: z.string().min(1)
  })
})

const STAND_IN_EMAIL = 'cloud-workspace@loom.invalid'
const TEN_YEARS_SECONDS = 10 * 365 * 24 * 3600

async function writePrivate(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(text)
    await handle.truncate(Buffer.byteLength(text))
  } finally {
    await handle.close()
  }
}

/** Only a dedicated sign-in container may produce a real Codex login. */
export async function readCodexSignIn(homePath: string): Promise<CodexLogin> {
  const parsed = codexFile.parse(
    JSON.parse(await readFile(path.join(homePath, '.codex', 'auth.json'), 'utf8'))
  )
  return {
    provider: 'codex',
    accessToken: parsed.tokens.access_token,
    refreshToken: parsed.tokens.refresh_token,
    idToken: parsed.tokens.id_token,
    accountId: parsed.tokens.account_id
  }
}

export function loginFilesFolder(homePath: string): string {
  return path.join(path.dirname(path.dirname(homePath)), 'login-files', path.basename(homePath))
}

/**
 * What Codex finds in the home instead of the sign-in: the same shape, so it believes it is
 * signed in to the same account and plan, with a stand-in where the tokens were. The identity
 * token is not signed; Codex only reads who it says the account is.
 */
function codexStandIn(login: CodexLogin, standIn: string): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  let real: Record<string, unknown> = {}
  try {
    real = JSON.parse(Buffer.from(login.idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    // An identity token that cannot be read still leaves the account id, which is what matters.
  }
  const account = (real['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>
  const now = Math.floor(Date.now() / 1000)
  const identity = [
    part({ alg: 'none', typ: 'JWT' }),
    part({
      aud: real['aud'],
      iss: real['iss'],
      auth_provider: real['auth_provider'],
      email: STAND_IN_EMAIL,
      email_verified: true,
      iat: now,
      exp: now + TEN_YEARS_SECONDS,
      sub: 'loom-stand-in',
      'https://api.openai.com/auth': {
        chatgpt_account_id: login.accountId,
        chatgpt_plan_type: account['chatgpt_plan_type'],
        chatgpt_user_id: 'loom-stand-in',
        user_id: 'loom-stand-in'
      }
    }),
    'loom-stand-in'
  ].join('.')
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      account_id: login.accountId,
      access_token: standIn,
      refresh_token: 'loom-stand-in',
      id_token: identity
    },
    // Codex renews a sign-in it thinks is old; this one is always new, and only the runner renews.
    last_refresh: new Date().toISOString()
  })
}

/** Codex's settings with its server address pointing at the proxy. Top-level keys come first in TOML. */
function withProxyAddress(settings: string, address: string): string {
  const others = settings.split('\n').filter((line) => !/^\s*chatgpt_base_url\s*=/.test(line))
  return [`chatgpt_base_url = "${address}"`, ...others].join('\n')
}

const run = promisify(execFile)
/** Both ways a repository on GitHub is named. */
const GITHUB_ADDRESSES = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/']

/**
 * Git's settings in the home, so that every repository on GitHub is reached through the
 * proxy with the stand-in, whether or not the person has connected GitHub. The checkout
 * still names GitHub as its origin; only where git goes changes. With no GitHub login the
 * proxy passes the call on as anybody, so what is public still works.
 */
async function pointGitAtProxy(home: HomeToSecure): Promise<void> {
  const file = path.join(home.homePath, '.gitconfig')
  const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (entry !== null && !entry.isFile()) throw new Error('The home git configuration must be a regular file')
  const front = `${home.githubUrl}/`
  const set = (...args: string[]): Promise<unknown> => run('git', ['config', '--file', file, ...args])
  // Unsetting what is not there fails, and that is fine.
  await set('--unset-all', `url.${front}.insteadOf`).catch(() => {})
  await set('--unset-all', `http.${front}.extraHeader`).catch(() => {})
  for (const address of GITHUB_ADDRESSES) await set('--add', `url.${front}.insteadOf`, address)
  await set(
    `http.${front}.extraHeader`,
    `Authorization: Bearer ${standInFor(home.key, home.userId, 'github')}`
  )
}

/**
 * The file in the home that a read-only login file is mounted over. It is made once and then
 * left exactly where it is. On Linux, removing a file takes away whatever a running container
 * has mounted over it: that container would lose its stand-in and could write a real login
 * into the home from then on. So it is only ever emptied in place, which also clears
 * anything that was written into it while nothing was mounted there.
 */
async function mountPoint(target: string): Promise<void> {
  const entry = await lstat(target).catch(() => null)
  // A folder or a link in its place is not something a file was ever mounted over.
  if (entry !== null && !entry.isFile()) await rm(target, { recursive: true, force: true })
  await writePrivate(target, '')
}

/** Mounted credential sources live outside the home and retain their inode on updates. */
export async function secureHome(home: HomeToSecure): Promise<void> {
  for (const relative of ['.claude', '.codex', '.config', '.config/gh']) {
    const directory = path.join(home.homePath, relative)
    await mkdir(directory, { recursive: true })
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Credential directories may not be symbolic links')
  }
  const kept = await home.vault.get(home.userId, 'codex')
  const values = [
    '{}',
    kept === null
      ? '{"OPENAI_API_KEY":null}'
      : codexStandIn(kept, standInFor(home.key, home.userId, 'codex')),
    ''
  ]
  for (const [index, relative] of LOGIN_FILES.entries()) {
    await mountPoint(path.join(home.homePath, relative))
    await writePrivate(path.join(loginFilesFolder(home.homePath), relative), values[index]!)
  }
  const settingsFile = path.join(home.homePath, '.codex', 'config.toml')
  const settings = await readFile(settingsFile, 'utf8').catch(() => '')
  // Nothing may come before /backend-api: Codex makes its model call at the host and port
  // of this address and drops any path in front, so the address has to be Codex's alone.
  const pointed = withProxyAddress(settings, `${home.codexUrl}/backend-api/`)
  if (pointed !== settings) await writePrivate(settingsFile, pointed)
  await pointGitAtProxy(home)
}
