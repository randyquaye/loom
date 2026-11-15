import path from 'node:path'
import type Database from 'better-sqlite3'
import type { WorkspaceRow } from '../../shared/ipc-contract'
import { setGitRuntimeResolver, type GitRuntime } from '../git/run'
import { runtimeFor as workspaceRuntime } from '../runtime'

type Container = Pick<WorkspaceRow, 'id' | 'runtime' | 'worktreePath' | 'ownerId' | 'state'>
interface RunnerGitOptions {
  db: Database.Database
  dataRoot: string
  runtimeFor?(workspace: Container, dataRoot: string): GitRuntime
}

// A detached checkpoint from a retired runner must never become host Git after replacement.
const isolatedRoots = new Set<string>()
const inside = (root: string, cwd: string) => cwd === root || cwd.startsWith(root + path.sep)

/** Only a fresh, not-yet-executed checkout may use trusted host Git during bootstrap. */
export function createRunnerGit(options: RunnerGitOptions) {
  const { db } = options
  const choose = options.runtimeFor ?? workspaceRuntime
  const rows = db.prepare(`SELECT id,runtime,state,worktree_path AS worktreePath,owner_id AS ownerId
    FROM workspaces WHERE runtime='container'`)
  let closed = false
  function containers(): Container[] {
    const workspaces = rows.all() as Container[]
    for (const workspace of workspaces) isolatedRoots.add(path.resolve(workspace.worktreePath))
    return workspaces
  }
  containers()
  setGitRuntimeResolver((given) => {
    const cwd = path.resolve(given)
    if (!closed && db.open) {
      const workspace = containers().find((entry) => inside(path.resolve(entry.worktreePath), cwd))
      if (workspace !== undefined) {
        if (workspace.state === 'initializing') return null
        return choose(workspace, options.dataRoot)
      }
    }
    if ([...isolatedRoots].some((root) => inside(root, cwd)))
      throw new Error('Container workspace Git is unavailable while its runner is stopped or replaced')
    return null
  })
  return {
    close(): void {
      if (closed) return
      if (db.open) containers()
      closed = true
      // Leave the closed fence installed; resetting to machine Git would revive old jobs.
    }
  }
}
