import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GhNotAuthenticatedError, GhNotInstalledError, GhRequestError, isAuthFailure } from './errors'

const execFileAsync = promisify(execFile)

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const GH_TIMEOUT_MS = 20_000

/**
 * gh resolves its target host and repository from the environment in preference to
 * flags, so an ambient GH_HOST or GH_REPO in the launching shell would silently
 * retarget a read away from github.com or from the project we were asked about.
 * Credentials are deliberately left alone: an env token is a documented gh auth path
 * and belongs to the user. Prompts and pagers are disabled because nothing here can
 * answer an interactive question.
 */
export function ghEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.GH_HOST
  delete env.GITHUB_HOST
  delete env.GH_REPO
  env.GH_PROMPT_DISABLED = '1'
  env.GH_PAGER = 'cat'
  env.NO_COLOR = '1'
  return env
}

function detail(err: unknown, key: string): string {
  if (typeof err !== 'object' || err === null) return ''
  const value: unknown = (err as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Injected in tests so no suite ever shells out to a real gh or the network. */
export type GhExec = (args: readonly string[]) => Promise<string>

async function runGh(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', [...args], {
      shell: false,
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: GH_TIMEOUT_MS,
      env
    })
    return stdout
  } catch (err) {
    const stderr = detail(err, 'stderr') || detail(err, 'message') || 'failed'
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new GhNotInstalledError()
    if (isAuthFailure(stderr)) throw new GhNotAuthenticatedError(stderr.split('\n')[0])
    throw new GhRequestError(args, stderr)
  }
}

export const ghExec: GhExec = (args) => runGh(args, ghEnv())

/** The runner supplies the caller's App token through the child environment only. */
export function ghWithToken(accessToken: string): GhExec {
  return (args) => runGh(args, { ...ghEnv(), GH_TOKEN: accessToken, GITHUB_TOKEN: accessToken })
}

export interface GhAuthState {
  installed: boolean
  /** The github.com account gh is signed in as, when it is signed in. */
  account: string | null
}

const ACCOUNT_LINE = /Logged in to github\.com account ([^\s(]+)/

/**
 * Reads gh's own auth state rather than probing the API, so Settings can show it
 * without a network round trip. gh prints this report on stdout and exits non-zero
 * when no credential is usable.
 */
export async function ghAuthState(exec: GhExec = ghExec): Promise<GhAuthState> {
  try {
    const match = ACCOUNT_LINE.exec(await exec(['auth', 'status']))
    return { installed: true, account: match?.[1] ?? null }
  } catch (err) {
    if (err instanceof GhNotInstalledError) return { installed: false, account: null }
    return { installed: true, account: null }
  }
}
