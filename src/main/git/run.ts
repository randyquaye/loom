import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/**
 * Prepended to every git invocation so that config inside a repository Loom opens
 * cannot execute anything: no hooks, no fsmonitor helper, no external diff driver,
 * and no ext::/file:: transports (either of which runs arbitrary commands).
 * The external diff driver is disabled per diff command with --no-ext-diff:
 * an empty `diff.external=` config value makes git exec an empty command line.
 */
export const GIT_HARDENING_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  // Without attributes, smudge/clean filter drivers declared in the repo's own
  // .git/config can never be selected, so a malicious repo cannot execute on
  // worktree add / checkout.
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'core.pager=cat'
]

export class GitError extends Error {
  readonly code = 'GIT_COMMAND_FAILED'

  constructor(args: readonly string[], detail: string) {
    // The code is embedded in the message because Electron's IPC boundary drops
    // everything but the message text when an error crosses to the renderer.
    super(`GIT_COMMAND_FAILED: git ${args.join(' ')}: ${detail}`)
    this.name = 'GitError'
  }
}

function text(err: unknown, key: string): string {
  if (typeof err !== 'object' || err === null) return ''
  const value: unknown = (err as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Runs `git -C <repoPath> ...` through execFile with shell:false, so branch names,
 * paths and URLs stay argv elements and are never re-interpreted as shell syntax.
 */
export async function gitRaw(repoPath: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...GIT_HARDENING_ARGS, '-C', repoPath, ...args], {
      shell: false,
      maxBuffer: MAX_OUTPUT_BYTES
    })
    return stdout
  } catch (err) {
    throw new GitError(args, text(err, 'stderr') || text(err, 'message') || 'failed')
  }
}

/** gitRaw with the usual whitespace trim; never use it for -z streams. */
export async function git(repoPath: string, args: readonly string[]): Promise<string> {
  return (await gitRaw(repoPath, args)).trim()
}

/** gitRaw with extra environment (checkpoints stage through a throwaway GIT_INDEX_FILE). */
export async function gitWithEnv(
  repoPath: string,
  args: readonly string[],
  extraEnv: Record<string, string>
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...GIT_HARDENING_ARGS, '-C', repoPath, ...args], {
      shell: false,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: { ...process.env, ...extraEnv }
    })
    return stdout.trim()
  } catch (err) {
    throw new GitError(args, text(err, 'stderr') || text(err, 'message') || 'failed')
  }
}
