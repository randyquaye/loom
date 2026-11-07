import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

export class ContainmentError extends Error {}

function assertInside(rootReal: string, target: string, label: string): void {
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
    throw new ContainmentError(`path escapes workspace: ${label}`)
  }
}

/**
 * Resolves userPath inside root and returns the real path, refusing escapes
 * including ones hidden behind symlinks (resolved via the deepest existing
 * ancestor, since the leaf may not exist yet for writes).
 */
export async function contain(root: string, userPath: string): Promise<string> {
  const rootReal = await realpath(root)
  const candidate = path.resolve(rootReal, userPath)
  assertInside(rootReal, candidate, userPath)

  let cursor = candidate
  for (;;) {
    let realCursor: string
    try {
      realCursor = await realpath(cursor)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      // A dangling symlink also yields ENOENT from realpath; writing through it
      // would land outside the jail, so refuse rather than ascend past it.
      const st = await lstat(cursor).catch(() => null)
      if (st !== null && st.isSymbolicLink()) {
        throw new ContainmentError(`dangling symlink escapes workspace: ${userPath}`)
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) return candidate
      cursor = parent
      continue
    }
    const resolved = path.join(realCursor, path.relative(cursor, candidate))
    assertInside(rootReal, resolved, userPath)
    return resolved
  }
}
