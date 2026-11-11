import type Database from 'better-sqlite3'
import type { SessionInstructionsInfo } from '../../shared/ipc-contract'

/** Reports recorded Loom text without rebuilding instructions or inspecting provider-managed files. */
export function sessionInstructions(db: Database.Database, sessionId: string): SessionInstructionsInfo {
  const row = db.prepare('SELECT backend, instruction_snapshot FROM sessions WHERE id = ?').get(sessionId) as
    { backend: string; instruction_snapshot: string | null } | undefined
  if (row === undefined) throw new Error(`unknown session ${sessionId}`)
  const text = row.instruction_snapshot
  return {
    status: text === null ? 'legacy' : text === '' ? 'pending' : 'saved',
    text: text === null || text === '' ? null : text,
    repositoryMode: row.backend === 'gemini' || row.backend === 'qwen' ? 'root-files' : 'native'
  }
}
