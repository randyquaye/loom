import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import path from 'node:path'
import { CONTEXT_DIR } from '../../shared/brand'
import { MANAGED_AGENTS_MARKER } from '../context/materialize'
import { git } from '../git/run'
import { contain } from '../security/contain'

type Retirement = 'absent' | 'preserved' | 'retired' | 'needs-review'

async function inspect(file: string): Promise<Stats | undefined> {
  try {
    return await lstat(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function restoreCaptured(backup: string, file: string): Promise<void> {
  try {
    await link(backup, file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }
  await unlink(backup)
}

/** Retires only a proven legacy companion, retaining its exact bytes outside native discovery. */
export async function retireWorkspaceAgentsDoc(
  worktreePath: string,
  expectedContent: () => Promise<string>
): Promise<Retirement> {
  const file = path.join(worktreePath, 'AGENTS.md')
  const original = await inspect(file)
  if (original === undefined) return 'absent'
  if (!original.isFile()) return 'preserved'

  const contents = await readFile(file)
  if (!contents.toString('utf8').startsWith(MANAGED_AGENTS_MARKER)) return 'preserved'
  if ((await git(worktreePath, ['ls-files', '--cached', '--', ':(top,icase)AGENTS.md'])) !== '')
    return 'preserved'

  const expected = Buffer.from(`${MANAGED_AGENTS_MARKER}\n${await expectedContent()}\n`)
  if (!contents.equals(expected)) return 'needs-review'

  const current = await inspect(file)
  if (current === undefined) return 'absent'
  if (!current.isFile()) return 'preserved'
  if (current.dev !== original.dev || current.ino !== original.ino) return 'needs-review'
  if (!(await readFile(file)).equals(contents)) return 'needs-review'
  if ((await git(worktreePath, ['ls-files', '--cached', '--', ':(top,icase)AGENTS.md'])) !== '')
    return 'preserved'

  const backupDir = await contain(worktreePath, path.join(CONTEXT_DIR, 'legacy-instructions'))
  await mkdir(backupDir, { recursive: true })
  const backup = path.join(backupDir, `AGENTS-${randomUUID()}.md`)
  await writeFile(backup, '', { flag: 'wx', mode: 0o600 })
  const placeholder = await lstat(backup)
  try {
    // Capture the actual current file atomically, rather than deleting a checked pathname.
    await rename(file, backup)
  } catch (error) {
    const remaining = await inspect(backup)
    if (
      remaining?.isFile() &&
      remaining.dev === placeholder.dev &&
      remaining.ino === placeholder.ino &&
      remaining.size === 0
    )
      await unlink(backup)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }

  let matches = false
  try {
    const captured = await lstat(backup)
    matches =
      captured.isFile() &&
      captured.dev === original.dev &&
      captured.ino === original.ino &&
      (await readFile(backup)).equals(contents) &&
      (await git(worktreePath, ['ls-files', '--cached', '--', ':(top,icase)AGENTS.md'])) === ''
  } catch (error) {
    await restoreCaptured(backup, file)
    throw error
  }
  if (matches) return 'retired'
  await restoreCaptured(backup, file)
  return 'needs-review'
}
