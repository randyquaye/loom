export type OrgRole = 'owner' | 'member'
export type OrgKind = 'human' | 'bot'

export interface Organization {
  name: string
  createdBy: string
  createdAt: number
}

export interface OrgMember {
  userId: string
  email: string
  role: OrgRole
  kind: OrgKind
  state: 'active' | 'removed'
  joinedAt: number
  removedAt: number | null
  removedBy: string | null
  purgeStartedAt: number | null
  purgedAt: number | null
}

export interface OrgInvite {
  id: string
  email: string
  createdBy: string
  createdAt: number
  expiresAt: number
  revokedAt: number | null
  usedAt: number | null
  usedBy: string | null
}

export interface OrgAdminEvent {
  id: number
  actorId: string
  action: string
  subject: string | null
  at: number
  detail: string | null
}

export interface OrgOverview {
  organization: Organization
  role: OrgRole
  kind: OrgKind
  /** Sign-in configuration and host usage are visible only to owners. */
  settings?: { domains: string[]; googleClientId: string; mode?: 'company' | 'managed' }
  health?: { disk: { total: number; available: number; warning: boolean } }
  usage?: Array<{ userId: string; email: string; running: number }>
}

export interface HostProof {
  host: string
  /** SPKI DER encoded as base64. */
  public_key: string
  signature: string
}

/** Company trust is retained verbatim; managed trust binds one host and Google client. */
export type RunnerTrust =
  { version: 3; domain: string } | { version: 4; host: string; googleClientId: string }

/** The org key authorizes this TLS leaf key for a short, signed interval. */
export interface TransportProof extends HostProof {
  tls_fingerprint: string
  issued_at: number
  expires_at: number
}

export const TRANSPORT_PROOF_TTL_MS = 15 * 60_000

export function transportProofPayload(
  proof: Pick<TransportProof, 'host' | 'tls_fingerprint' | 'issued_at' | 'expires_at'>
): string {
  return JSON.stringify([
    'loom.transport-proof.v1',
    proof.host,
    proof.tls_fingerprint,
    proof.issued_at,
    proof.expires_at
  ])
}
