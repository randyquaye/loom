import { createHash, randomBytes } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { AgentEvent } from '../../shared/events'
import type { SessionRow, WorkspaceRow } from '../../shared/ipc-contract'
import { connectRunner } from '../cloud/client'
import { aesGcmCipher, createSecretStore } from '../secrets'
import { homeFolder } from '../runtime'
import { startRunner } from './runner'

interface SavedWorkspace {
  id: string
  project_id: string
  worktree_path: string
  runtime: string
  state: string
  owner_id: string | null
}

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

const digest = (events: AgentEvent[]) => createHash('sha256').update(JSON.stringify(events)).digest('hex')

async function containedDirectory(root: string, directory: string): Promise<void> {
  const resolved = await realpath(directory)
  if (!resolved.startsWith(`${root}${path.sep}`))
    throw new Error('Restored workspace is outside the data disk')
  if (!(await stat(resolved)).isDirectory()) throw new Error('Restored workspace directory is missing')
}

/**
 * Rehearsal only, on an isolated copy. Logins and their renewal are deliberately never wired.
 * The runner recovers interrupted work and serves its restored history, but receives no send.
 */
export async function verifyRestoredData(dataDir: string, key: Buffer) {
  if (key.length !== 32) throw new Error('The recovery key must contain exactly 32 bytes')
  const root = await realpath(dataDir)
  const db = new Database(path.join(root, 'loom.db'), { readonly: true, fileMustExist: true })
  let workspaces: SavedWorkspace[]
  let owners: Array<{ id: string; email: string }>
  let sessions: Array<{
    id: string
    workspace_id: string
    closed_at: number | null
    provider_session_id: string | null
  }>
  const histories = new Map<string, { count: number; digest: string }>()
  let savedQueue: Array<{ id: string; payload: string }>
  let userMessages: number
  let conversations: number
  try {
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    if (
      integrity.some((row) => row.integrity_check !== 'ok') ||
      (db.pragma('foreign_key_check') as unknown[]).length > 0
    )
      throw new Error('The restored database failed its integrity checks')
    workspaces = db
      .prepare('SELECT id, project_id, worktree_path, runtime, state, owner_id FROM workspaces')
      .all() as SavedWorkspace[]
    owners = db.prepare('SELECT id, email FROM users').all() as typeof owners
    sessions = db
      .prepare('SELECT id, workspace_id, closed_at, provider_session_id FROM sessions')
      .all() as typeof sessions
    savedQueue = db.prepare('SELECT id, payload FROM queued_messages').all() as typeof savedQueue
    for (const session of sessions) {
      const rows = db
        .prepare('SELECT payload FROM events WHERE session_id = ? ORDER BY seq')
        .all(session.id) as Array<{ payload: string }>
      const events = rows.map((row) => JSON.parse(row.payload) as AgentEvent)
      histories.set(session.id, { count: events.length, digest: digest(events) })
    }
    userMessages = count(db, "SELECT COUNT(*) AS n FROM events WHERE type = 'user.text'")
    conversations = count(db, 'SELECT COUNT(*) AS n FROM sessions WHERE provider_session_id IS NOT NULL')
    for (const workspace of workspaces) {
      if (workspace.state !== 'ready') continue
      await containedDirectory(root, workspace.worktree_path)
      await stat(path.join(workspace.worktree_path, '.git'))
      if (workspace.runtime === 'container')
        await containedDirectory(root, homeFolder(root, workspace.owner_id))
    }
  } finally {
    db.close()
  }
  const vault = createSecretStore(path.join(root, 'secrets.enc'), aesGcmCipher(key))
  const entries = await vault.listRaw('')
  // Authenticated decryption proves that the separately recovered key matches this disk.
  // Values are neither logged nor handed to any provider implementation.
  for (const entry of entries) await vault.getRaw(entry)
  const identities = owners.map((owner) => ({
    userId: owner.id,
    email: owner.email,
    token: randomBytes(32).toString('base64url')
  }))
  if (identities.length === 0) throw new Error('The restored runner has no owners to verify')
  const runner = await startRunner({
    dataDir: root,
    secretKey: key,
    devIdentities: identities,
    host: '127.0.0.1',
    port: 0,
    placement: { checkout: 'clone', runtime: 'container' },
    allowLocalRemotes: false,
    idleMs: 0
  })
  try {
    for (const identity of identities) {
      let ready!: () => void
      const connected = new Promise<void>((resolve) => {
        ready = resolve
      })
      const client = connectRunner({
        url: `ws://127.0.0.1:${runner.port}`,
        token: async () => identity.token,
        onPush: () => {},
        onState: (state) => {
          if (state.state === 'connected') ready()
        }
      })
      let timer: NodeJS.Timeout | undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Restored runner did not answer')), 10_000)
      })
      try {
        await Promise.race([
          (async () => {
            await connected
            const owned = workspaces.filter((workspace) => workspace.owner_id === identity.userId)
            for (const projectId of new Set(owned.map((workspace) => workspace.project_id))) {
              const listed = (await client.call('workspaces:list', { projectId })) as WorkspaceRow[]
              const expected = owned
                .filter((workspace) => workspace.project_id === projectId)
                .map((workspace) => workspace.id)
                .sort()
              if (JSON.stringify(listed.map((workspace) => workspace.id).sort()) !== JSON.stringify(expected))
                throw new Error('Restored workspace ownership or listing did not match the snapshot')
            }
            for (const workspace of owned) {
              const tabs = (await client.call('sessions:list', { workspaceId: workspace.id })) as SessionRow[]
              const savedTabs = sessions.filter((tab) => tab.workspace_id === workspace.id)
              const expectedOpen = savedTabs
                .filter((tab) => tab.closed_at === null)
                .map((tab) => [tab.id, tab.provider_session_id])
                .sort()
              const actualOpen = tabs.map((tab) => [tab.id, tab.providerSessionId]).sort()
              if (
                tabs.some((tab) => tab.workspaceId !== workspace.id) ||
                JSON.stringify(actualOpen) !== JSON.stringify(expectedOpen)
              )
                throw new Error('Restored tabs or conversation IDs did not match the snapshot')
              for (const tab of savedTabs) {
                const events = (await client.call('sessions:events', { sessionId: tab.id })) as AgentEvent[]
                const saved = histories.get(tab.id)!
                if (digest(events.slice(0, saved.count)) !== saved.digest)
                  throw new Error('Restored history did not match the snapshot')
              }
            }
          })(),
          deadline
        ])
      } finally {
        clearTimeout(timer)
        client.close()
      }
    }
  } finally {
    await runner.close()
  }
  const recovered = new Database(path.join(root, 'loom.db'), { readonly: true, fileMustExist: true })
  try {
    if (count(recovered, "SELECT COUNT(*) AS n FROM events WHERE type = 'user.text'") !== userMessages)
      throw new Error('A user message was replayed during recovery')
    for (const entry of savedQueue) {
      const restored = recovered.prepare('SELECT payload FROM queued_messages WHERE id = ?').get(entry.id) as
        { payload: string } | undefined
      if (restored?.payload !== entry.payload)
        throw new Error('A saved queued message was lost during recovery')
    }
    const providerIds = recovered.prepare('SELECT id, provider_session_id FROM sessions ORDER BY id').all()
    const expectedIds = sessions
      .map((tab) => ({ id: tab.id, provider_session_id: tab.provider_session_id }))
      .sort((a, b) => a.id.localeCompare(b.id))
    if (JSON.stringify(providerIds) !== JSON.stringify(expectedIds))
      throw new Error('Saved conversation IDs changed during recovery')
    return {
      workspaces: workspaces.length,
      sessions: sessions.length,
      userMessages,
      conversations,
      queuedMessages: count(recovered, 'SELECT COUNT(*) AS n FROM queued_messages'),
      encryptedEntries: entries.length
    }
  } finally {
    recovered.close()
  }
}
