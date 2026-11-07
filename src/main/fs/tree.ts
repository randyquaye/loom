import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import type { FileNode } from '../../shared/ipc-contract'
import { contain } from '../security/contain'

/** One listing cap; the renderer loads folders lazily, so a cap only bounds a single directory. */
export const DIR_LIST_CAP = 2000
const SKIPPED_DIRS = new Set(['.git', 'node_modules'])

function compareEntries(a: Dirent, b: Dirent): number {
  const aDir = a.isDirectory()
  const bDir = b.isDirectory()
  if (aDir !== bDir) return aDir ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function isListed(entry: Dirent): boolean {
  return !(entry.isDirectory() && SKIPPED_DIRS.has(entry.name))
}

async function readSorted(absDir: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(absDir, { withFileTypes: true })
    return entries.filter(isListed).sort(compareEntries)
  } catch {
    return []
  }
}

/**
 * Lists exactly one directory level (directories first); the renderer expands
 * folders on demand, so deep or huge repos never lose root-level files to a
 * global node budget. Symlinked dirs stay leaves (Dirent.isDirectory is false
 * for symlinks) and are never followed.
 */
export async function listDir(
  worktreePath: string,
  relDir: string,
  cap: number = DIR_LIST_CAP
): Promise<FileNode[]> {
  const absDir = await contain(worktreePath, relDir === '' ? '.' : relDir)
  const entries = await readSorted(absDir)
  return entries.slice(0, cap).map((entry) => {
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`
    return entry.isDirectory()
      ? { name: entry.name, path: relPath, kind: 'dir' as const }
      : { name: entry.name, path: relPath, kind: 'file' as const }
  })
}
