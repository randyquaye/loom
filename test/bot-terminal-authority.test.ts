import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const harness = vi.hoisted(() => ({
  environment: Promise.resolve(),
  create: vi.fn(() => 'terminal'),
  write: vi.fn()
}))
vi.mock('../src/main/pty', () => ({
  createTerminal: harness.create,
  writeTerminal: harness.write,
  terminalIdForCwd: () => 'existing',
  listTerminals: () => [],
  destroyTerminal: vi.fn(),
  resizeTerminal: vi.fn(),
  setActiveTerminal: vi.fn()
}))
vi.mock('../src/main/runtime', () => ({ runtimeFor: () => ({ ensureRunning: async () => {} }) }))
vi.mock('../src/main/workspace/bootstrap', () => ({
  workspaceEnv: async () => {
    await harness.environment
    return {}
  },
  repositoryRoot: () => '/fixture',
  createWorkspace: vi.fn(),
  removeWorkspace: vi.fn()
}))
vi.mock('../src/main/config/repo-settings', () => ({
  readRepoSettings: async () => ({ run: [{ id: 'build', command: 'fixture-build' }] })
}))
import { openDb } from '../src/main/db'
import { dispatch, type IpcDeps } from '../src/main/ipc/registry'
import { registerTerminalIpc } from '../src/main/ipc/terminal'
import { registerWorkspacesIpc } from '../src/main/ipc/workspaces'

let db: ReturnType<typeof openDb>
let release: () => void
beforeEach(() => {
  vi.clearAllMocks()
  db = openDb(':memory:')
  db.prepare("INSERT INTO projects(id,name,repo_path,created_at) VALUES ('p','fixture','/fixture',0)").run()
  db.prepare(
    "INSERT INTO workspaces(id,project_id,name,branch,worktree_path,created_at) VALUES ('w','p','fixture','loom/fixture','/fixture',0)"
  ).run()
  harness.environment = new Promise<void>((resolve) => {
    release = resolve
  })
})
afterEach(() => {
  release()
  db.close()
})

describe('bot terminal authority at execution', () => {
  it.each(['terminal:create', 'workspaces:runAction'])(
    'rechecks control before %s mutates a terminal after asynchronous environment lookup',
    async (channel) => {
      let control = true
      const guard = () => {
        if (!control) throw new Error('Control revoked')
      }
      const deps = { db, dataRoot: '/fixture', secrets: {} } as IpcDeps
      registerTerminalIpc(deps, guard)
      registerWorkspacesIpc(deps, { runtime: 'machine', checkout: 'worktree' }, guard)
      const pending = dispatch(
        channel,
        { workspaceId: 'w', ...(channel === 'workspaces:runAction' ? { actionId: 'build' } : {}) },
        { userId: 'controller' }
      ) as Promise<unknown>
      control = false
      release()
      await expect(pending).rejects.toThrow(/revoked/)
      expect(harness.create).not.toHaveBeenCalled()
      expect(harness.write).not.toHaveBeenCalled()
    }
  )
})
