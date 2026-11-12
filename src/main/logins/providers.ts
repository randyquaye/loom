import type { IncomingHttpHeaders } from 'node:http'
import type { LoginProvider } from './stand-in'
import type { ClaudeLogin, CodexLogin, GithubLogin, Login } from './vault'

/** Where a call is sent on: one of the provider's own servers, and the path there. */
export interface Route {
  origin: string
  path: string
}

/** What the proxy needs to know about one provider's servers. */
export interface ProviderRules<L extends Login = Login> {
  /** How the provider is named to a person. */
  label: string
  /**
   * Where a call goes. Only the provider's own servers are ever named here, so a real login
   * is sent nowhere else; and only the calls the program was seen to need have a route.
   * Null is a call with none: it is refused, so a stand-in cannot be used to read or change
   * the account behind the login.
   */
  route(path: string): Route | null
  /**
   * Set where a call may go on with no login at all, because the server answers anybody
   * about what is public. The stand-in is still required: only whose call it is, is known.
   */
  openToAnybody?: true
  /** Puts the real login on a request in place of the stand-in. `path` is the call as it arrived. */
  authorize(headers: IncomingHttpHeaders, login: L, path: string): void
}

/** A route to the same path at `origin`, for a call that is one of `allowed` or lies beneath one. */
function under(origin: string, allowed: readonly string[]): (path: string) => Route | null {
  return (path) =>
    allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) ? { origin, path } : null
}

const claude: ProviderRules<ClaudeLogin> = {
  label: 'Claude',
  route: under('https://api.anthropic.com', ['/v1/messages', '/v1/models', '/api/hello']),
  authorize(headers, login) {
    headers.authorization = `Bearer ${login.accessToken}`
  }
}

const codex: ProviderRules<CodexLogin> = {
  label: 'Codex',
  route: under('https://chatgpt.com', [
    '/backend-api/codex',
    '/backend-api/wham',
    '/backend-api/ps',
    '/backend-api/plugins'
  ]),
  authorize(headers, login) {
    headers.authorization = `Bearer ${login.accessToken}`
    // Whatever account the container names, the call is made as the one the login is for.
    headers['chatgpt-account-id'] = login.accountId
  }
}

/** git's three calls on a repository over HTTPS: what it has, fetch, push. */
const GIT_CALL = /^\/[\w.-]+\/[\w.-]+\/(info\/refs|git-upload-pack|git-receive-pack)$/
const GITHUB_API = 'https://api.github.com'
/** How gh addresses a GitHub that is not github.com, which is what the proxy looks like to it. */
const API_PREFIX = '/api/v3'

const github: ProviderRules<GithubLogin> = {
  label: 'GitHub',
  // Fetching a public repository, or one a dependency names, must not need a GitHub login.
  openToAnybody: true,
  // git, and the API as gh speaks it. None of GitHub's pages: that is where tokens are made.
  route(path) {
    if (path === '/api/graphql') return { origin: GITHUB_API, path: '/graphql' }
    if (path.startsWith(`${API_PREFIX}/`)) return { origin: GITHUB_API, path: path.slice(API_PREFIX.length) }
    return GIT_CALL.test(path) ? { origin: 'https://github.com', path } : null
  },
  authorize(headers, login, path) {
    // The API takes the token as it is; git over HTTPS takes it as a password.
    headers.authorization = path.startsWith('/api/')
      ? `Bearer ${login.accessToken}`
      : `Basic ${Buffer.from(`x-access-token:${login.accessToken}`).toString('base64')}`
  }
}

export const PROVIDERS = { claude, codex, github } satisfies Record<LoginProvider, unknown>

export function isLoginProvider(name: string): name is LoginProvider {
  return Object.hasOwn(PROVIDERS, name)
}
