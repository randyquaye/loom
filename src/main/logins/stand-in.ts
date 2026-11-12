import { createHmac, timingSafeEqual } from 'node:crypto'

/** Whose logins the runner keeps for its users: the two agents, and GitHub for git and gh. */
export type LoginProvider = 'claude' | 'codex' | 'github'

/** What each program expects a login to begin with, so it takes the stand-in for one. */
const SHAPE: Record<LoginProvider, string> = { claude: 'sk-ant-oat01-loom', codex: 'loom', github: 'loom' }
const USER_ID = /^[A-Za-z0-9_-]+$/

function proof(key: Buffer, provider: LoginProvider, userId: string): string {
  return createHmac('sha256', key).update(`loom.stand-in.v1\0${provider}\0${userId}`).digest('base64url')
}

/**
 * What a container holds in place of a real login. It names its user and proves, with the
 * host's key, that this runner issued it for that user and that agent. It is not a login:
 * the agent's real servers refuse it, and all it opens is the runner's own proxy. Nothing
 * is stored for it, so there is no table of stand-ins to leak.
 */
export function standInFor(key: Buffer, userId: string, provider: LoginProvider): string {
  if (!USER_ID.test(userId)) throw new Error(`"${userId}" cannot be given a stand-in login`)
  return `${SHAPE[provider]}.${userId}.${proof(key, provider, userId)}`
}

/** Whose stand-in this is, when it is one of ours for that agent; null for anything else. */
export function standInUser(key: Buffer, provider: LoginProvider, token: string): string | null {
  const [shape, userId, given, ...more] = token.split('.')
  if (shape !== SHAPE[provider] || userId === undefined || given === undefined || more.length > 0) return null
  if (!USER_ID.test(userId)) return null
  const expected = Buffer.from(proof(key, provider, userId))
  const actual = Buffer.from(given)
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? userId : null
}
