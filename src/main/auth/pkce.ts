import { createHash, randomBytes } from 'node:crypto'

/** RFC 7636 section 4.1: 43 to 128 unreserved characters. */
export const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/

/** The secret half, kept by whoever starts a sign-in and shown only when it is finished. */
export function newVerifier(): string {
  return randomBytes(32).toString('base64url')
}

/** The public half (S256): safe to send ahead, useless for finishing the sign-in. */
export function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}
