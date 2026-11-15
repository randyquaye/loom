import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { WorkspaceRuntime } from '../runtime/types'

const execFileAsync = promisify(execFile)

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

export type GitRuntime = Pick<WorkspaceRuntime, 'exec'>
type GitRuntimeResolver = (cwd: string) => GitRuntime | null
let runtimeResolver: GitRuntimeResolver | null = null

/** The runner confines container-owned Git; the desktop keeps its ordinary machine behavior. */
export function setGitRuntimeResolver(next: GitRuntimeResolver | null): void {
  runtimeResolver = next
}

export function gitRuntimeFor(cwd: string): GitRuntime | null {
  return runtimeResolver?.(cwd) ?? null
}

/**
 * Common Git command hooks are disabled. Repository attributes can still select filters,
 * so container-owned repositories must also run Git inside their execution boundary.
 * The external diff driver is disabled per diff command with --no-ext-diff:
 * an empty `diff.external=` config value makes git exec an empty command line.
 */
export const GIT_HARDENING_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  // Disable the global attribute source; repository attributes remain Git's own behavior.
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'core.pager=cat'
]

const CONTAINER_IDENTITY_ARGS = [
  '-c',
  'user.name=Loom',
  '-c',
  'user.email=loom@localhost',
  '-c',
  'commit.gpgsign=false'
] as const

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
    const runtime = gitRuntimeFor(repoPath)
    if (runtime !== null) {
      const { stdout } = await runtime.exec(
        'git',
        [...GIT_HARDENING_ARGS, ...CONTAINER_IDENTITY_ARGS, '-C', repoPath, ...args],
        {
          cwd: repoPath,
          maxBuffer: MAX_OUTPUT_BYTES
        }
      )
      return stdout
    }
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
    const runtime = gitRuntimeFor(repoPath)
    if (runtime !== null) {
      if (Object.keys(extraEnv).some((key) => key !== 'GIT_INDEX_FILE'))
        throw new Error('Host Git credential environment cannot be forwarded to a container workspace')
      const { stdout } = await runtime.exec(
        'git',
        [...GIT_HARDENING_ARGS, ...CONTAINER_IDENTITY_ARGS, '-C', repoPath, ...args],
        {
          cwd: repoPath,
          maxBuffer: MAX_OUTPUT_BYTES,
          env: { ...extraEnv }
        }
      )
      return stdout.trim()
    }
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
