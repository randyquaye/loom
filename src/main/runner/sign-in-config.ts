import { readFile } from 'node:fs/promises'
import { googleClient } from '../auth/google'
import { createHostProof } from '../auth/host-proof'
import { isGoogleClientId, isManagedRunnerOrigin } from '../../shared/managed-cloud'
import type { SignInConfig } from './runner'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required for runner sign-in`)
  return value
}

/** Missing production configuration must never fall back to a developer bearer token. */
export async function readSignInConfig(env: NodeJS.ProcessEnv): Promise<SignInConfig | undefined> {
  const mode = env['LOOM_SIGN_IN_MODE'] ?? 'company'
  if (mode !== 'company' && mode !== 'managed') throw new Error('Invalid LOOM_SIGN_IN_MODE')
  const clientId = env['LOOM_GOOGLE_CLIENT_ID']
  if (!clientId) {
    if (
      env['LOOM_SIGN_IN_MODE'] ||
      env['LOOM_GOOGLE_CLIENT_SECRET'] ||
      env['LOOM_SIGN_IN_DOMAINS'] ||
      env['LOOM_OWNER_EMAIL']
    )
      throw new Error('LOOM_GOOGLE_CLIENT_ID is required when sign-in settings are present')
    return undefined
  }
  const publicUrl = required(env, 'LOOM_PUBLIC_URL')
  const url = new URL(publicUrl)
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('LOOM_PUBLIC_URL must be an https origin')
  if (mode === 'managed' && (!isManagedRunnerOrigin(publicUrl) || !isGoogleClientId(clientId)))
    throw new Error('Managed sign-in requires a Loom-operated HTTPS host and valid Google client')
  const domains =
    mode === 'managed'
      ? []
      : required(env, 'LOOM_SIGN_IN_DOMAINS')
          .split(/[\s,]+/)
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)
  const ownerEmail = required(env, 'LOOM_OWNER_EMAIL').trim().toLowerCase()
  if ((mode === 'company' && domains.length === 0) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail))
    throw new Error('Valid sign-in domains and a first-owner email are required')
  const signingKey = await readFile(required(env, 'LOOM_RUNNER_SIGNING_KEY_FILE'), 'utf8')
  createHostProof(signingKey, url.origin, 'startup-validation')
  return {
    mode,
    google: googleClient({ clientId, clientSecret: required(env, 'LOOM_GOOGLE_CLIENT_SECRET') }),
    googleClientId: clientId,
    domains,
    ownerEmail,
    signingKey,
    transportProofFile: required(env, 'LOOM_TRANSPORT_PROOF_FILE'),
    publicUrl: url.origin
  }
}
