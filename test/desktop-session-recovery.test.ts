import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { migrate } from '../src/main/db/migrations'
import type { AgentEvent } from '../src/shared/events'
import { openTurn } from '../src/shared/turn-state'

const startup = vi.hoisted(() => ({
  db: null as Database.Database | null,
  windowCreated: vi.fn(),
  failed: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    enableSandbox: vi.fn(),
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getPath: () => '/fixture',
    isPackaged: true,
    quit: vi.fn(),
    on: vi.fn()
  },
  BrowserWindow: class {
    constructor() {
      startup.windowCreated()
    }
    on = vi.fn()
    loadFile = vi.fn()
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() }
  },
  dialog: { showErrorBox: startup.failed },
  safeStorage: {}
}))
vi.mock('../src/main/db', () => ({ openDb: () => startup.db }))
vi.mock('../src/main/env/login-path', () => ({ adoptLoginPath: async () => {} }))
vi.mock('../src/main/instructions/migrate-general', () => ({ migrateProjectInstructions: async () => {} }))
vi.mock('../src/main/secrets', () => ({ createSecretStore: () => ({}), safeStorageCipher: () => ({}) }))
vi.mock('../src/main/cloud/account', () => ({ openCloudAccount: async () => ({ close: vi.fn() }) }))
vi.mock('../src/main/cloud/route', () => ({ createCloudRoute: vi.fn() }))
vi.mock('../src/main/agents/wiring', () => ({ registerBackends: vi.fn() }))
vi.mock('../src/main/pty', () => ({ setTerminalSink: vi.fn(), destroyAllTerminals: vi.fn() }))
vi.mock('../src/main/shell/open', () => ({ openExternalSafe: vi.fn() }))
vi.mock('../src/main/updates', () => ({
  openDesktopUpdater: async () => ({ status: () => ({ state: 'unavailable' }), close: vi.fn() })
}))
vi.mock('../src/main/ipc', () => ({
  registerIpc: vi.fn(),
  setIpcRouter: vi.fn(),
  setNotificationSink: vi.fn(),
  setTrustedOrigin: vi.fn(),
  missingChannelHandlers: () => []
}))

function events(db: Database.Database, sessionId: string): AgentEvent[] {
  const rows = db
    .prepare('SELECT payload FROM events WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as Array<{ payload: string }>
  return rows.map(({ payload }) => JSON.parse(payload) as AgentEvent)
}

afterEach(() => {
  startup.db?.close()
  startup.db = null
  startup.windowCreated.mockReset()
  startup.failed.mockReset()
  vi.unstubAllEnvs()
  vi.resetModules()
})

it.each(['accepted', 'started'] as const)(
  'desktop startup recovers %s work before displaying history, without replaying queued input',
  async (phase) => {
    vi.stubEnv('LOOM_DATA_DIR', '/fixture')
    const db = new Database(':memory:')
    startup.db = db
    migrate(db)
    db.exec(`
      INSERT INTO projects (id, name, repo_path, created_at) VALUES ('p', 'demo', '/fixture', 1);
      INSERT INTO workspaces (id, project_id, name, branch, worktree_path, created_at)
        VALUES ('w', 'p', 'demo', 'loom/demo', '/fixture', 1);
    `)
    const insertEvent = db.prepare(
      'INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)'
    )
    const completed: AgentEvent[] = [
      { type: 'user.text', turnId: 'finished', text: 'already answered' },
      { type: 'turn.done', turnId: 'finished', stopReason: 'end' }
    ]
    const abandoned: AgentEvent[] = [{ type: 'user.text', turnId: 'prompt', text: 'saved request' }]
    if (phase === 'started') abandoned.push({ type: 'turn.started', turnId: 'provider', at: 1 })
    for (const [id, history] of [
      ['stale', abandoned],
      ['complete', completed]
    ] as const) {
      db.prepare(
        `INSERT INTO sessions
        (id, workspace_id, backend, model, effort, title, created_at)
        VALUES (?, 'w', 'codex', 'test', 'medium', 'demo', 1)`
      ).run(id)
      history.forEach((event, index) => insertEvent.run(id, index + 1, 1, event.type, JSON.stringify(event)))
    }
    const queued = JSON.stringify({ id: 'q', text: 'wait for me', images: [] })
    db.prepare('INSERT INTO queued_messages (id, session_id, position, payload) VALUES (?, ?, ?, ?)').run(
      'q',
      'stale',
      0,
      queued
    )
    let displayed: AgentEvent[] = []
    startup.windowCreated.mockImplementation(() => {
      displayed = events(db, 'stale')
    })

    await import('../src/main/index')
    await vi.waitFor(() => {
      expect(startup.failed).not.toHaveBeenCalled()
      expect(startup.windowCreated).toHaveBeenCalledOnce()
    })

    expect(openTurn(displayed)).toBeUndefined()
    expect(displayed.at(-1)).toMatchObject({
      type: 'turn.done',
      turnId: phase === 'started' ? 'provider' : 'prompt',
      stopReason: 'interrupted'
    })
    expect(displayed.filter((event) => event.type === 'user.text')).toEqual(abandoned.slice(0, 1))
    expect(events(db, 'complete')).toEqual(completed)
    expect(db.prepare('SELECT payload FROM queued_messages WHERE id = ?').get('q')).toEqual({
      payload: queued
    })
  }
)
