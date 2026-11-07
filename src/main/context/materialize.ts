import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CONTEXT_DIR } from '../../shared/brand'
import { COMMENTS_FILE } from '../db/repos/comments'
import { contain } from '../security/contain'

/** Conductor caps attachments at ten; oldest are evicted on write. */
export const ATTACHMENT_CAP = 10
const ATTACHMENTS_DIR = 'attachments'

export interface WorkspaceContext {
  workspaceName: string
  branch: string
  repoPath: string
  backend: string
  model: string
  effort: string
  at: number
  /** Names only: the context file is readable inside the worktree, values never are. */
  envNames: string[]
}

export function contextText(ctx: WorkspaceContext): string {
  return [
    '# Loom workspace context',
    '',
    `workspace: ${ctx.workspaceName}`,
    `branch: ${ctx.branch}`,
    `repository: ${ctx.repoPath}`,
    `session agent: ${ctx.backend} / ${ctx.model} / effort ${ctx.effort}`,
    `written: ${new Date(ctx.at).toISOString()}`,
    '',
    ...(ctx.envNames.length > 0
      ? [
          'Environment variables in your process environment (values are secret; never',
          `echo, print or commit them): ${ctx.envNames.join(', ')}`,
          ''
        ]
      : []),
    'Attachments referenced by chat turns (fork transcripts, terminal selections)',
    `live in ${CONTEXT_DIR}/${ATTACHMENTS_DIR}/.`,
    ''
  ].join('\n')
}

/** Writes the per-workspace context blob agents are pointed at by the system prompt. */
export async function writeLoomContext(worktreePath: string, ctx: WorkspaceContext): Promise<void> {
  const dir = path.join(worktreePath, CONTEXT_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'loom.context'), contextText(ctx), 'utf8')
}

export function attachmentFileName(kind: 'transcript' | 'terminal', title: string, at: number): string {
  if (kind === 'terminal') {
    const stamp = new Date(at).toISOString().replace(/[:.]/g, '-')
    return `terminal-selection-${stamp}.txt`
  }
  const slug =
    title
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  return `Transcript of ${slug}.md`
}

/**
 * Writes one attachment under .context/attachments/ and evicts past the cap.
 * Returns the workspace-relative path for prompt references.
 */
export async function writeAttachment(worktreePath: string, fileName: string, text: string): Promise<string> {
  const dir = path.join(worktreePath, CONTEXT_DIR, ATTACHMENTS_DIR)
  await mkdir(dir, { recursive: true })
  const safe = fileName.replace(/[/\\]/g, '-').replace(/\.\.+/g, '.')
  const abs = await contain(dir, safe)
  await writeFile(abs, text, 'utf8')
  await evictOldest(dir)
  return `${CONTEXT_DIR}/${ATTACHMENTS_DIR}/${safe}`
}

async function evictOldest(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files: Array<{ name: string; mtime: number }> = []
  for (const entry of entries) {
    // The comments mirror is agent-facing state, not an evictable attachment.
    if (!entry.isFile() || entry.name === COMMENTS_FILE) continue
    const info = await stat(path.join(dir, entry.name)).catch(() => null)
    if (info !== null) files.push({ name: entry.name, mtime: info.mtimeMs })
  }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const old of files.slice(ATTACHMENT_CAP)) {
    await rm(path.join(dir, old.name), { force: true }).catch(() => {})
  }
}

const MANAGED_AGENTS_MARKER = '<!-- loom:managed -->'

export { MANAGED_AGENTS_MARKER }

/**
 * codex has no system-prompt flag and reads AGENTS.md only from the worktree root, so Loom
 * keeps a managed companion there while the path is free. The marker comes first so a repo
 * or user file that takes the path is never overwritten; returns whether Loom owns the file.
 */
export async function refreshWorkspaceAgentsDoc(worktreePath: string, content: string): Promise<boolean> {
  const { readFile } = await import('node:fs/promises')
  const file = path.join(worktreePath, 'AGENTS.md')
  const existing = await readFile(file, 'utf8').catch(() => null)
  if (existing !== null && !existing.startsWith(MANAGED_AGENTS_MARKER)) return false
  await writeFile(file, `${MANAGED_AGENTS_MARKER}\n${content}\n`, 'utf8')
  return true
}
