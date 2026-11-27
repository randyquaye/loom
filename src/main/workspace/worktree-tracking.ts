import path from 'node:path'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { WorkspaceRow } from '../../shared/ipc-contract'
import { currentBranch } from '../git/branches'
import { listWorktrees } from '../git/worktree'
import { runtimeFor } from '../runtime'
import { nodeForWorkspace } from './worktree-tool'

export interface WorkspaceBranch {
  branch: string
  path: string
  sessionId: string
  source: 'workspace' | 'registered' | 'discovered'
}
export function knownWorkspaceBranches(db: Database.Database, workspaceId: string): WorkspaceBranch[] {
  return db
    .prepare(
      `SELECT branch,worktree_path AS path,session_id AS sessionId,source
    FROM workspace_branches WHERE workspace_id=? ORDER BY observed_at DESC`
    )
    .all(workspaceId) as WorkspaceBranch[]
}
const registration = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
  branch: z.string().min(1).max(200),
  path: z.string()
})
const READ = String.raw`
const fs = require('node:fs'), path = require('node:path');
const root = fs.realpathSync(process.argv[1]);
const dir = path.join(root, '.context/worktrees/records');
let result = [];
if (fs.existsSync(dir)) {
  if (!fs.realpathSync(dir).startsWith(root + path.sep)) throw Error('Registrations escape workspace');
  for (const name of fs.readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).slice(0, 500)) {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 8192) {
      try { result.push(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch {}
    }
  }
}
process.stdout.write(JSON.stringify(result));
`

/** Git's registered paths establish membership; file records only add session attribution. */
export async function refreshWorkspaceBranches(
  db: Database.Database,
  workspace: WorkspaceRow,
  dataRoot: string | null = null
): Promise<WorkspaceBranch[]> {
  const root = workspace.worktreePath
  const entries = await listWorktrees(root)
  const head = await currentBranch(root)
  const candidates: WorkspaceBranch[] = [
    { branch: workspace.branch, path: root, sessionId: '', source: 'workspace' },
    ...entries
      .filter((entry) => entry.branch !== null && entry.path.startsWith(root + path.sep))
      .map((entry) => ({
        branch: entry.branch!,
        path: entry.path,
        sessionId: '',
        source: 'discovered' as const
      }))
  ]
  if (head) candidates.push({ branch: head, path: root, sessionId: '', source: 'workspace' })
  const runtime = runtimeFor(workspace, dataRoot)
  const result = await runtime
    .exec(nodeForWorkspace(workspace.runtime), ['-e', READ, root], {
      cwd: root,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: 10000,
      maxBuffer: 1024 * 1024
    })
    .catch(() => ({ stdout: '[]', stderr: '' }))
  const records: unknown = JSON.parse(result.stdout)
  if (Array.isArray(records))
    for (const raw of records) {
      const parsed = registration.safeParse(raw)
      if (!parsed.success) continue
      const record = parsed.data
      if (
        record.workspaceId !== workspace.id ||
        !entries.some((entry) => entry.path === record.path && entry.branch === record.branch)
      )
        continue
      const session = db
        .prepare('SELECT id FROM sessions WHERE id=? AND workspace_id=?')
        .get(record.sessionId, workspace.id)
      candidates.push({
        branch: record.branch,
        path: record.path,
        sessionId: session ? record.sessionId : '',
        source: 'registered'
      })
    }
  const save =
    db.prepare(`INSERT INTO workspace_branches(workspace_id,branch,session_id,worktree_path,source,observed_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,branch,session_id) DO UPDATE SET
    worktree_path=excluded.worktree_path,source=excluded.source,observed_at=excluded.observed_at`)
  db.transaction(() => {
    for (const row of candidates)
      save.run(workspace.id, row.branch, row.sessionId, row.path, row.source, Date.now())
  })()
  return knownWorkspaceBranches(db, workspace.id)
}
