import type Database from 'better-sqlite3'
import type { UserInstructions } from '../../shared/runner-contract'
import { getProjectOrThrow } from '../db/repos/projects'
import { readInstructionOverlay } from './files'
import { migrateProjectInstructions } from './migrate-general'

/**
 * The instruction text the user wrote on this machine for a project: what a runner needs to
 * be sent, because it cannot read these files itself.
 */
export async function userInstructions(
  db: Database.Database,
  dataRoot: string,
  projectId: string
): Promise<UserInstructions> {
  await migrateProjectInstructions(db, dataRoot, projectId)
  return {
    overlay: await readInstructionOverlay(dataRoot, projectId),
    general: getProjectOrThrow(db, projectId).customPromptGeneral
  }
}
