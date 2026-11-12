import { z } from 'zod'
import type { GithubLogin } from './vault'

export interface GithubAppConfig {
  clientId: string
  clientSecret: string
  slug: string
  publicUrl: string
}

export interface GithubClient {
  clientId: string
  installUrl: string
  authorizeUrl(state: string): string
  exchange(code: string): Promise<GithubLogin>
  renew(login: GithubLogin): Promise<GithubLogin>
  installed(accessToken: string): Promise<boolean>
}

export class GithubAuthorizationRefused extends Error {}

const token = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token_expires_in: z.number().positive()
})

export function githubClient(config: GithubAppConfig, request: typeof fetch = fetch): GithubClient {
  const callback = `${config.publicUrl.replace(/\/$/, '')}/auth/github/callback`
  async function api(route: string, accessToken: string): Promise<unknown> {
    const response = await request(`https://api.github.com${route}`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'Loom'
      },
      signal: AbortSignal.timeout(20000),
      redirect: 'error'
    })
    if (response.status === 401) throw new GithubAuthorizationRefused('GitHub authorization expired')
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
    return response.json()
  }
  async function installed(accessToken: string): Promise<boolean> {
    const result = z
      .object({ total_count: z.number() })
      .parse(await api('/user/installations?per_page=1', accessToken))
    return result.total_count > 0
  }
  async function exchange(fields: Record<string, string>, previous?: GithubLogin): Promise<GithubLogin> {
    const response = await request('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...fields
      }),
      signal: AbortSignal.timeout(20000),
      redirect: 'error'
    })
    if (response.status >= 400 && response.status < 500)
      throw new GithubAuthorizationRefused(`GitHub answered ${response.status}`)
    if (!response.ok) throw new Error('GitHub could not be reached')
    const body: unknown = await response.json()
    const error = z.object({ error: z.string() }).safeParse(body)
    if (error.success) {
      // GitHub's own word for what went wrong is no secret, and is what whoever runs the host needs.
      const why = `GitHub answered ${error.data.error}`
      if (
        [
          'bad_verification_code',
          'bad_refresh_token',
          'incorrect_client_credentials',
          'expired_token'
        ].includes(error.data.error)
      ) {
        throw new GithubAuthorizationRefused(why)
      }
      throw new Error(why)
    }
    const issued = token.safeParse(body)
    if (!issued.success) {
      throw new Error(
        'GitHub sent no token that expires and can be renewed. Check that "Expire user authorization tokens" is on for the app'
      )
    }
    const next = issued.data
    const account =
      previous?.account ??
      z.object({ login: z.string().min(1) }).parse(await api('/user', next.access_token)).login
    return {
      provider: 'github',
      accessToken: next.access_token,
      refreshToken: next.refresh_token,
      expiresAt: Date.now() + next.expires_in * 1000,
      refreshExpiresAt: Date.now() + next.refresh_token_expires_in * 1000,
      account,
      clientId: config.clientId,
      installed: previous?.installed ?? (await installed(next.access_token))
    }
  }
  return {
    clientId: config.clientId,
    installUrl: `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`,
    authorizeUrl(state) {
      const url = new URL('https://github.com/login/oauth/authorize')
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: callback,
        state,
        scope: 'offline_access'
      }).toString()
      return url.toString()
    },
    exchange: (code) => exchange({ code, redirect_uri: callback }),
    renew: (login) => exchange({ grant_type: 'refresh_token', refresh_token: login.refreshToken }, login),
    installed
  }
}
