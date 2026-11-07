import { readFileJailed } from '../fs/read'
import { git, gitRaw } from './run'

export interface ChangeEntry {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
  unstaged: boolean
}

const DIFF_LINE_CAP = 4000

function kindOf(xy: string): ChangeEntry['status'] {
  if (xy === '??') return 'untracked'
  if (xy.includes('D')) return 'deleted'
  if (xy.includes('R')) return 'renamed'
  if (xy.includes('A')) return 'added'
  return 'modified'
}

/**
 * `status --porcelain=v1 -z`: NUL-separated `XY path` records, with renames and
 * copies carrying the source path as an extra record. -z also disables path
 * quoting, so names arrive verbatim.
 */
export async function listChanges(worktreePath: string): Promise<ChangeEntry[]> {
  const out = await gitRaw(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  if (out === '') return []
  const records = out.split('\0')
  const entries: ChangeEntry[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record === undefined || record.length < 4) continue
    const xy = record.slice(0, 2)
    if (xy === '!!') continue
    if (xy[0] === 'R' || xy[0] === 'C') i++
    entries.push({
      path: record.slice(3),
      status: kindOf(xy),
      // Untracked entries carry '?' in both columns: neither staged nor unstaged.
      staged: xy !== '??' && xy[0] !== ' ' && xy[0] !== '?',
      unstaged: xy !== '??' && xy[1] !== ' '
    })
  }
  return entries
}

function capDiff(diff: string): string {
  const lines = diff.split('\n')
  if (lines.length <= DIFF_LINE_CAP) return diff
  return `${lines.slice(0, DIFF_LINE_CAP).join('\n')}\n… ${lines.length - DIFF_LINE_CAP} more diff lines not shown`
}

/**
 * Worktree-vs-HEAD diff for one path. Untracked paths have no HEAD side, so
 * their diff is synthesised as all-additions from the (jailed, size-capped)
 * file content; unreadable or binary files degrade to a one-line note.
 */
export async function diffFor(worktreePath: string, relPath: string): Promise<string> {
  const tracked = await git(worktreePath, ['diff', '--no-ext-diff', 'HEAD', '--', relPath]).catch(() => '')
  if (tracked !== '') return capDiff(tracked)
  try {
    const { text } = await readFileJailed(worktreePath, relPath)
    const lines = text.split('\n')
    const shown = lines.slice(0, DIFF_LINE_CAP)
    const body = shown.map((line) => `+${line}`).join('\n')
    const more =
      lines.length > DIFF_LINE_CAP ? `\n+… ${lines.length - DIFF_LINE_CAP} more lines not shown` : ''
    return `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +${shown.length} @@\n${body}${more}`
  } catch {
    return `binary or unreadable file: ${relPath}`
  }
}
