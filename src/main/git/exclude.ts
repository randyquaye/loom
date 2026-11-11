import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
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

function hasLine(contents: string, entry: string): boolean {
  return contents.split('\n').some((line) => line.trim() === entry)
}

function withLine(contents: string, entry: string): string {
  const separator = contents === '' || contents.endsWith('\n') ? '' : '\n'
  return `${contents}${separator}${entry}\n`
}

const editing = new Map<string, Promise<void>>()

/**
 * Read-modify-write of the shared exclude file, serialized per file: a workspace
 * bootstrapping while another runs a turn would otherwise interleave two rewrites and
 * drop one entry — losing `.context/` lets agents commit attachments and notes.
 * `edit` returns null for no change.
 */
async function editExclude(repoPath: string, edit: (current: string) => string | null): Promise<void> {
  const file = await excludeFilePath(repoPath)
  const run = (editing.get(file) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const existing = await lstat(file).catch(() => null)
      if (existing !== null && existing.isSymbolicLink()) {
        throw new Error(`refusing to write git exclude through a symlink: ${file}`)
      }
      const next = edit(await readFile(file, 'utf8').catch(() => ''))
      if (next === null) return
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, next, 'utf8')
    })
  editing.set(file, run)
  try {
    await run
  } finally {
    if (editing.get(file) === run) editing.delete(file)
  }
}

export function ensureContextIgnored(repoPath: string): Promise<void> {
  return editExclude(repoPath, (current) =>
    hasLine(current, EXCLUDE_ENTRY) ? null : withLine(current, EXCLUDE_ENTRY)
  )
}
