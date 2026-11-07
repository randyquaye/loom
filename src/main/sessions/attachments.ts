import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { contain } from '../security/contain'

export const ATTACH_MAX_COUNT = 8
export const ATTACH_MAX_BYTES = 256 * 1024
export const ATTACH_MAX_LINES = 4000

export class AttachmentError extends Error {
  readonly code = 'ATTACHMENT_REJECTED'

  constructor(detail: string) {
    super(`ATTACHMENT_REJECTED: ${detail}`)
    this.name = 'AttachmentError'
  }
}

/**
 * Credential-shaped directory segments, checked against the REAL path after symlink
 * resolution. An attachment is inlined into the turn and sent to a model provider, so with
 * arbitrary paths the risk is not escaping a jail — there is no jail — it is shipping a
 * secret on a mis-click.
 */
const DENIED_DIR_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', 'Keychains', '.netrc'])

/** Credential-shaped file names; applied to workspace files too, where the mis-click is your own repo's .env. */
const DENIED_NAMES = [
  /^\.env(\..*)?$/,
  /^id_[a-z0-9]+(\.pub)?$/,
  /\.(pem|p12|pfx|kdbx|keystore)$/i,
  /^\.netrc$/,
  /credentials(\.[a-z0-9]+)?$/i
]

function assertNotDenied(real: string, deniedRoots: readonly string[]): void {
  const segments = real.split(path.sep)
  if (segments.some((segment) => DENIED_DIR_SEGMENTS.has(segment))) {
    throw new AttachmentError(`refusing a credential directory: ${real}`)
  }
  const base = path.basename(real)
  if (DENIED_NAMES.some((pattern) => pattern.test(base))) {
    throw new AttachmentError(`refusing a credential-shaped file name: ${base}`)
  }
  for (const root of deniedRoots) {
    if (real === root || real.startsWith(root + path.sep)) {
      throw new AttachmentError(`refusing a path inside ${root}`)
    }
  }
}

export interface ResolvedAttachment {
  /** The real, vetted path that will be read. */
  abs: string
  /** How the transcript should name it: worktree-relative when inside, absolute otherwise. */
  label: string
}

/**
 * Vets one attachment path. Relative paths are jailed to the worktree by contain();
 * absolute paths (from the native dialog) get the deny-list, a regular-file check and
 * symlink resolution instead, because there is no jail to hold them.
 */
export async function resolveAttachment(
  worktreePath: string,
  raw: string,
  deniedRoots: readonly string[] = []
): Promise<ResolvedAttachment> {
  if (path.isAbsolute(raw)) {
    const real = await realpath(path.normalize(raw)).catch(() => null)
    if (real === null) throw new AttachmentError(`no such file: ${raw}`)
    assertNotDenied(real, deniedRoots)
    return { abs: real, label: real }
  }
  const contained = await contain(worktreePath, raw)
  assertNotDenied(contained, deniedRoots)
  return { abs: contained, label: raw }
}

export interface AttachmentContent {
  text: string
  lines: number
  bytes: number
  truncated: boolean
}

export async function readAttachment(abs: string): Promise<AttachmentContent> {
  const info = await stat(abs)
  if (!info.isFile()) throw new AttachmentError(`not a regular file: ${abs}`)
  if (info.size > ATTACH_MAX_BYTES) {
    throw new AttachmentError(`larger than ${ATTACH_MAX_BYTES} bytes: ${abs}`)
  }
  const buffer = await readFile(abs)
  // A NUL byte in the head means binary; inlining it would put garbage in the transcript.
  if (buffer.subarray(0, 8192).includes(0)) throw new AttachmentError(`binary file: ${abs}`)
  const lines = buffer.toString('utf8').split('\n')
  const truncated = lines.length > ATTACH_MAX_LINES
  const text = truncated ? lines.slice(0, ATTACH_MAX_LINES).join('\n') : lines.join('\n')
  return { text, lines: lines.length, bytes: buffer.length, truncated }
}

/** The block the agent sees: a header naming the file, then its content in a fence. */
export function formatAttachment(label: string, content: AttachmentContent): string {
  const kb = (content.bytes / 1024).toFixed(1)
  const note = content.truncated ? `, truncated to first ${ATTACH_MAX_LINES} lines` : ''
  const fence = content.text.includes('```') ? '````' : '```'
  return `<attached file: ${label} — ${content.lines} lines, ${kb} KB${note}>\n${fence}\n${content.text}\n${fence}`
}
