import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { RepoSettings } from '../config/repo-settings'
import { gitRaw } from '../git/run'

export const COPY_FILE_CAP = 2000
const SKIP_DIRS = new Set(['.git', 'node_modules'])
const DEFAULT_GLOBS = ['.env*']
const WORKTREEINCLUDE = '.worktreeinclude'

// gitignore-style subset: star, double-star and question mark; a double-star
// followed by a slash also matches zero directories. (No block comment here:
// the slash-star-slash sequence inside one would terminate it early.)
export function globToRegex(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string
    if (ch === '*') {
      if (glob.slice(i, i + 3) === '**/') {
        out += '(?:.*/)?'
        i += 2
      } else if (glob[i + 1] === '*') {
        out += '.*'
        i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${out}$`)
}

/** Conductor's resolution order: .worktreeinclude, then repo settings globs, then .env*. */
export async function resolveIncludeGlobs(repoPath: string, settings: RepoSettings): Promise<string[]> {
  const raw = await readFile(path.join(repoPath, WORKTREEINCLUDE), 'utf8').catch(() => null)
  if (raw !== null) {
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
    if (lines.length > 0) return lines
  }
  if (settings.fileIncludeGlobs.length > 0) return settings.fileIncludeGlobs
  return [...DEFAULT_GLOBS]
}

/**
 * Copies matching files from the repository root checkout into a fresh
 * worktree (gitignored seeds like .env never arrive via worktree add).
 * Tracked checkout content is never clobbered; the cap bounds runaway globs.
 */
export async function copyWorkspaceFiles(
  repoPath: string,
  worktreePath: string,
  globs: string[]
): Promise<number> {
  const listed = await gitRaw(repoPath, ['ls-files', '-z', '--cached', '--others'])
  const regexes = globs.map(globToRegex)
  let copied = 0
  for (const rel of listed.split('\0')) {
    if (rel === '' || copied >= COPY_FILE_CAP) break
    if (rel.split('/').some((part) => SKIP_DIRS.has(part))) continue
    if (!regexes.some((re) => re.test(rel))) continue
    const dest = path.join(worktreePath, rel)
    const existing = await stat(dest).catch(() => null)
    if (existing !== null) continue
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFile(path.join(repoPath, rel), dest)
    copied += 1
  }
  return copied
}
