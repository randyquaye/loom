import path from 'node:path'
import type { WorkspaceRuntime } from '../runtime/types'
import type { WorkspaceRow } from '../../shared/ipc-contract'
import source from './worktree-cli.mjs?raw'

export const nodeForWorkspace = (runtime?: WorkspaceRow['runtime']) =>
  runtime === 'container' ? 'node' : process.execPath

export const WORKTREE_TOOL_INSTRUCTIONS =
  'For an additional task branch, run `loom worktree create --branch NAME --base REF` in your shell, ' +
  'then work in the returned JSON path. It creates a separate checkout and records this session. ' +
  'For an existing worktree use `loom worktree register --path DIRECTORY`; `loom worktree list` lists registrations. ' +
  'The helper does not push, fetch, or authorize commits. Keep the original workspace branch unchanged.'

const INSTALL = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.realpathSync(process.argv[1]);
let dir = root;
for (const part of ['.context', 'bin']) {
  dir = path.join(dir, part);
  fs.mkdirSync(dir, { recursive: true });
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Unsafe Loom helper directory');
}
const temporary = path.join(dir, crypto.randomUUID() + '.tmp');
fs.writeFileSync(temporary, fs.readFileSync(0), { mode: 0o700, flag: 'wx' });
fs.renameSync(temporary, path.join(dir, 'loom.mjs'));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const wrapper = '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ' + quote(process.argv[2]) + ' ' + quote(path.join(dir, 'loom.mjs')) + ' "$@"\n';
fs.writeFileSync(temporary, wrapper, { mode: 0o700, flag: 'wx' });
fs.renameSync(temporary, path.join(dir, 'loom'));
process.stdout.write(process.env.PATH || '/usr/local/bin:/usr/bin:/bin');
`

/** Install through the workspace runtime; container-owned paths never execute on the host. */
export async function prepareWorktreeTool(
  runtime: WorkspaceRuntime,
  workspace: Pick<WorkspaceRow, 'id' | 'worktreePath'> & Partial<Pick<WorkspaceRow, 'runtime'>>,
  sessionId: string,
  env: Record<string, string>
): Promise<Record<string, string>> {
  const binary = nodeForWorkspace(workspace.runtime)
  const result = await runtime.exec(binary, ['-e', INSTALL, workspace.worktreePath, binary], {
    cwd: workspace.worktreePath,
    input: source,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    timeoutMs: 10000,
    maxBuffer: 65536
  })
  return {
    ...env,
    LOOM_WORKSPACE_PATH: workspace.worktreePath,
    LOOM_WORKSPACE_ID: workspace.id,
    LOOM_SESSION_ID: sessionId,
    PATH: `${path.join(workspace.worktreePath, '.context', 'bin')}:${result.stdout.trim()}`
  }
}
