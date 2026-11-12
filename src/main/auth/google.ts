// Ported from Sentinel (apps/api/src/routes/google-auth.ts at bee6e80).

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])
const EXCHANGE_TIMEOUT_MS = 10_000
/** Allowance for the two clocks disagreeing. */
const CLOCK_SKEW_SECONDS = 60

/** What Google vouches for about the person who just signed in. */
export interface GoogleIdentity {
  email: string
  emailVerified: boolean
  /** The Google Workspace domain; null for a personal account. */
  hostedDomain: string | null
}

/** The two things Loom asks of Google. A stand-in for it in tests implements the same. */
export interface GoogleClient {
  /** Where to send the browser so the person can choose their account. */
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string
  /** Swaps Google's code for an identity, asking Google directly; null when it cannot be trusted. */
  identify(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<GoogleIdentity | null>
}

/**
 * Reads the identity token Google's token endpoint returned.
 *
 * The signature is NOT verified here. That is only sound because the token came straight
 * from Google, over TLS, in answer to a request carrying our client secret. This function
 * must never be given a token that a desktop, a browser or any other client sent in: such a
 * token would need its signature checked against Google's keys. It is private for that reason.
 * Issuer, audience and age are still checked, so a token minted for another app cannot be
 * replayed here.
 */
function readIdToken(idToken: string, clientId: string): GoogleIdentity | null {
  const payload = idToken.split('.')
  if (payload.length !== 3 || payload[1] === undefined) return null
  let claims: Record<string, unknown>
  try {
    claims = JSON.parse(Buffer.from(payload[1], 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  const now = Math.floor(Date.now() / 1000)
  const expires = typeof claims['exp'] === 'number' ? claims['exp'] : 0
  const issued = typeof claims['iat'] === 'number' ? claims['iat'] : 0
  const email = typeof claims['email'] === 'string' ? claims['email'] : ''
  if (
    typeof claims['iss'] !== 'string' ||
    !ISSUERS.has(claims['iss']) ||
    claims['aud'] !== clientId ||
    expires + CLOCK_SKEW_SECONDS < now ||
    issued - CLOCK_SKEW_SECONDS > now ||
    typeof claims['sub'] !== 'string' ||
    claims['sub'] === '' ||
    email === ''
  ) {
    return null
  }
  const domain = claims['hd']
  return {
    email: email.toLowerCase(),
    // Google sends this as a boolean or the string "true", depending on the endpoint.
    emailVerified: claims['email_verified'] === true || claims['email_verified'] === 'true',
    hostedDomain: typeof domain === 'string' && domain !== '' ? domain.toLowerCase() : null
  }
}

/** The real Google. The client secret it holds never leaves the runner's host. */
export function googleClient(config: { clientId: string; clientSecret: string }): GoogleClient {
  return {
    authorizeUrl({ state, codeChallenge, redirectUri }) {
      const query = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account'
      })
      return `${AUTH_URL}?${query.toString()}`
    },

    async identify({ code, codeVerifier, redirectUri }) {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier
        }),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
      }).catch(() => null)
      if (response === null || !response.ok) return null
      const body = (await response.json().catch(() => null)) as { id_token?: unknown } | null
      return typeof body?.id_token === 'string' ? readIdToken(body.id_token, config.clientId) : null
    }
  }
}
