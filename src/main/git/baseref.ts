import { git } from './run'

export class BaseRefRejectedError extends Error {
  readonly code = 'BASE_REF_REJECTED'

  constructor(detail: string) {
    super(`BASE_REF_REJECTED: ${detail}`)
    this.name = 'BaseRefRejectedError'
  }
}

export class BaseRefUnavailableError extends Error {
  readonly code = 'BASE_REF_UNAVAILABLE'

  constructor(baseRef: string, detail: string) {
    super(`BASE_REF_UNAVAILABLE: "${baseRef}" is not available locally or on origin: ${detail}`)
    this.name = 'BaseRefUnavailableError'
  }
}

/** Injected in tests so the fetch path can be asserted without a reachable remote. */
export type GitRunner = (repoPath: string, args: readonly string[]) => Promise<string>

/**
 * The base ref reaches git as an argv element that git then resolves, so a leading dash
 * would be read as an option and a colon would rewrite a fetch refspec. Rejecting both up
 * front keeps every downstream interpolation unambiguous.
 */
export function assertSafeBaseRef(baseRef: string): void {
  const trimmed = baseRef.trim()
  if (trimmed === '') throw new BaseRefRejectedError('a base ref must not be empty')
  if (trimmed.startsWith('-')) throw new BaseRefRejectedError('a base ref must not start with "-"')
  if (/\s/.test(trimmed)) throw new BaseRefRejectedError('a base ref must not contain whitespace')
  if (trimmed.includes(':')) throw new BaseRefRejectedError('a base ref must not contain ":"')
}

/** git is the authority on whether a name resolves; --quiet exits 1 without noise. */
async function resolves(run: GitRunner, repoPath: string, ref: string): Promise<boolean> {
  try {
    await run(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

/**
 * Resolves a base ref to something `git worktree add` can start from. A pull-request head
 * picked from GitHub usually exists only on origin, so this fetches it. The fetch writes
 * local remote-tracking refs and nothing else — no ref is pushed and the working tree of
 * the user's checkout is untouched.
 */
export async function resolveBaseRef(
  repoPath: string,
  baseRef: string,
  run: GitRunner = git
): Promise<string> {
  assertSafeBaseRef(baseRef)
  if (await resolves(run, repoPath, baseRef)) return baseRef

  const remoteRef = `refs/remotes/origin/${baseRef}`
  const refspec = `+refs/heads/${baseRef}:${remoteRef}`
  try {
    await run(repoPath, ['fetch', '--no-tags', '--quiet', 'origin', refspec])
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new BaseRefUnavailableError(baseRef, detail)
  }
  // A fetch can exit 0 without creating the ref (an odd refspec match), so confirm it.
  if (!(await resolves(run, repoPath, remoteRef))) {
    throw new BaseRefUnavailableError(baseRef, 'origin did not provide that branch')
  }
  return remoteRef
}
