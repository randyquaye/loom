export interface GithubRepoRef {
  owner: string
  repo: string
}

const GITHUB_HOST = 'github.com'
// file://github.com/o/r and git://github.com/o/r both report a github.com host without
// being github.com fetches, so the scheme gates them, not the host alone.
const REMOTE_PROTOCOLS = new Set(['https:', 'http:', 'ssh:'])
const URL_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//
const SCP_REMOTE = /^(?:[^/@:\s]+@)?([^/:\s]+):(\S*)$/
const OWNER_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/
const MAX_OWNER_LENGTH = 39
const MAX_REPO_LENGTH = 100

function stripGitSuffix(repo: string): string {
  return repo.endsWith('.git') ? repo.slice(0, -'.git'.length) : repo
}

function toRef(owner: string, repo: string): GithubRepoRef | null {
  const name = stripGitSuffix(repo)
  // A leading dash would be read as a flag by `gh --repo owner/repo`.
  if (owner.startsWith('-') || name.startsWith('-')) return null
  if (owner.length > MAX_OWNER_LENGTH || !OWNER_PATTERN.test(owner)) return null
  if (name.length > MAX_REPO_LENGTH || !REPO_PATTERN.test(name)) return null
  // The URL parser folds ./ and ../ out of a path; scp-style remotes never go through it.
  if (name === '.' || name === '..') return null
  if (name.endsWith('.git')) return null
  return { owner, repo: name }
}

function refFromPath(pathname: string): GithubRepoRef | null {
  const segments = pathname.split('/').filter((segment) => segment !== '')
  const owner = segments[0]
  const repo = segments[1]
  if (owner === undefined || repo === undefined) return null
  return toRef(owner, repo)
}

function refFromUrl(url: string): GithubRepoRef | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!REMOTE_PROTOCOLS.has(parsed.protocol)) return null
  // ssh:// is an opaque-host scheme, so WHATWG leaves its host in the written case.
  if (parsed.hostname.toLowerCase() !== GITHUB_HOST) return null
  return refFromPath(parsed.pathname)
}

function refFromScp(url: string): GithubRepoRef | null {
  const match = SCP_REMOTE.exec(url)
  if (match === null) return null
  if (match[1]?.toLowerCase() !== GITHUB_HOST) return null
  return refFromPath(match[2] ?? '')
}

/** Parses a git remote URL into a github.com owner/repo pair, or null if it is not one. */
export function parseGithubRepo(remoteUrl: string | null): GithubRepoRef | null {
  if (remoteUrl === null) return null
  const url = remoteUrl.trim()
  if (url === '') return null
  return URL_PREFIX.test(url) ? refFromUrl(url) : refFromScp(url)
}
