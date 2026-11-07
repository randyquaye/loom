import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CONTEXT_DIR } from '../../shared/brand'
import { git } from './run'

const EXCLUDE_ENTRY = `${CONTEXT_DIR}/`

/**
 * `info/exclude` lives in the common git dir, so one entry covers the main
 * checkout and every linked worktree without touching any tracked file.
 */
async function excludeFilePath(repoPath: string): Promise<string> {
  const commonDir = await git(repoPath, ['rev-parse', '--git-common-dir'])
  return path.resolve(repoPath, commonDir, 'info', 'exclude')
}

export async function ensureContextIgnored(repoPath: string): Promise<void> {
  const { lstat } = await import('node:fs/promises')
  const file = await excludeFilePath(repoPath)
  const existing = await lstat(file).catch(() => null)
  if (existing !== null && existing.isSymbolicLink()) {
    throw new Error(`refusing to write git exclude through a symlink: ${file}`)
  }
  const current = await readFile(file, 'utf8').catch(() => '')
  if (hasExcludeEntry(current)) return
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, withExcludeEntry(current), 'utf8')
}

export function hasExcludeEntry(contents: string): boolean {
  return contents.split('\n').some((line) => line.trim() === EXCLUDE_ENTRY)
}

export function withExcludeEntry(contents: string): string {
  const separator = contents === '' || contents.endsWith('\n') ? '' : '\n'
  return `${contents}${separator}${EXCLUDE_ENTRY}\n`
}

const AGENTS_ENTRY = '/AGENTS.md'

function hasAgentsEntry(contents: string): boolean {
  return contents.split('\n').some((line) => line.trim() === AGENTS_ENTRY)
}

function withAgentsEntry(contents: string): string {
  const separator = contents === '' || contents.endsWith('\n') ? '' : '\n'
  return `${contents}${separator}${AGENTS_ENTRY}\n`
}

/**
 * The root AGENTS.md Loom writes for codex is untracked litter unless excluded, but an
 * exclude line would also hide a user's own untracked AGENTS.md — so the line rides only
 * while Loom owns the file, and is withdrawn the moment a repo or user file takes the path.
 */
export async function setAgentsExclude(repoPath: string, owned: boolean): Promise<void> {
  const { lstat } = await import('node:fs/promises')
  const file = await excludeFilePath(repoPath)
  const existing = await lstat(file).catch(() => null)
  if (existing !== null && existing.isSymbolicLink()) {
    throw new Error(`refusing to write git exclude through a symlink: ${file}`)
  }
  const current = await readFile(file, 'utf8').catch(() => '')
  const has = hasAgentsEntry(current)
  if (owned === has) return
  const next = owned
    ? withAgentsEntry(current)
    : current
        .split('\n')
        .filter((line) => line.trim() !== AGENTS_ENTRY)
        .join('\n')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, next, 'utf8')
}
