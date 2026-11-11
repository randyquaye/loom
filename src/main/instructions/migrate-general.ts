import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import type Database from 'better-sqlite3'
import type { ProjectPromptsInput } from '../../shared/ipc-contract'
import { getProjectOrThrow, setProjectPrompts } from '../db/repos/projects'
import {
  instructionFile,
  instructionLimit,
  InstructionTooLongError,
  readInstructions,
  writeInstructions,
  writeTextAtomically
} from './files'

interface MigrationReceipt {
  general: string
  before: string
  after: string
}

const pending = new Map<string, Promise<void>>()
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(key)
  const work = (previous ?? Promise.resolve()).catch(() => undefined).then(operation)
  const settled = work.then(
    () => undefined,
    () => undefined
  )
  pending.set(key, settled)
  try {
    return await work
  } finally {
    if (pending.get(key) === settled) pending.delete(key)
  }
}

async function readReceipt(file: string): Promise<MigrationReceipt | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const receipt = JSON.parse(text) as Partial<MigrationReceipt>
  if (
    ![receipt.general, receipt.before, receipt.after].every(
      (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    )
  ) {
    throw new Error('General migration receipt needs recovery; original instructions were preserved.')
  }
  return receipt as MigrationReceipt
}

async function migrate(db: Database.Database, dataRoot: string, projectId: string): Promise<void> {
  const general = getProjectOrThrow(db, projectId).customPromptGeneral
  const file = instructionFile(dataRoot, 'project', projectId)
  const receiptFile = `${file}.general-migration.json`
  if (general === null) {
    await rm(receiptFile, { force: true })
    return
  }
  const current = await readInstructions(dataRoot, 'project', projectId)
  const existing = await readReceipt(receiptFile)
  const merged =
    existing?.after === digest(current) ? current : `${current}${current === '' ? '' : '\n\n'}${general}`
  const receipt: MigrationReceipt = existing ?? {
    general: digest(general),
    before: digest(current),
    after: digest(merged)
  }
  if (
    receipt.general !== digest(general) ||
    ![receipt.before, receipt.after].includes(digest(current)) ||
    receipt.after !== digest(merged)
  ) {
    throw new Error('General or project instructions changed during migration; recovery is required.')
  }
  if (merged.length > instructionLimit('project')) throw new InstructionTooLongError('project', merged.length)
  if (existing === null) await writeTextAtomically(receiptFile, JSON.stringify(receipt))
  // Recheck after the receipt write so an external edit is never silently treated as migrated.
  if (digest(await readInstructions(dataRoot, 'project', projectId)) !== digest(current)) {
    throw new Error('Project instructions changed during migration; recovery is required.')
  }
  await writeInstructions(dataRoot, 'project', projectId, merged)
  if (digest(await readInstructions(dataRoot, 'project', projectId)) !== receipt.after) {
    throw new Error('Project instructions changed before migration completed; recovery is required.')
  }
  const result = db
    .prepare('UPDATE projects SET custom_prompt_general = NULL WHERE id = ? AND custom_prompt_general = ?')
    .run(projectId, general)
  if (result.changes !== 1)
    throw new Error('General instructions changed during migration; recovery is required.')
  await rm(receiptFile, { force: true })
}

/** Merge legacy General without losing either source across interrupted file/database updates. */
export function migrateProjectInstructions(
  db: Database.Database,
  dataRoot: string,
  projectId: string
): Promise<void> {
  return serialize(instructionFile(dataRoot, 'project', projectId), () => migrate(db, dataRoot, projectId))
}

/** A shorter explicit edit can recover a legacy merge that exceeds the new project limit. */
export function saveProjectInstructions(
  db: Database.Database,
  dataRoot: string,
  projectId: string,
  text: string
): Promise<void> {
  return serialize(instructionFile(dataRoot, 'project', projectId), async () => {
    const general = getProjectOrThrow(db, projectId).customPromptGeneral
    const before = await readInstructions(dataRoot, 'project', projectId)
    try {
      await migrate(db, dataRoot, projectId)
    } catch (error) {
      if (!(error instanceof InstructionTooLongError)) throw error
    }
    if (general !== null && before !== (await readInstructions(dataRoot, 'project', projectId))) {
      text += `${text === '' ? '' : '\n\n'}${general}`
    }
    await writeInstructions(dataRoot, 'project', projectId, text)
    await migrate(db, dataRoot, projectId)
  })
}

/** Preserve the old General API while immediately consolidating newly supplied text. */
export function saveProjectPrompts(
  db: Database.Database,
  dataRoot: string,
  input: ProjectPromptsInput
): Promise<void> {
  return serialize(instructionFile(dataRoot, 'project', input.projectId), async () => {
    const previous = getProjectOrThrow(db, input.projectId).customPromptGeneral
    try {
      await migrate(db, dataRoot, input.projectId)
    } catch (error) {
      if (
        !(error instanceof InstructionTooLongError) ||
        input.general === null ||
        input.general.trim() === '' ||
        input.general === previous
      )
        throw error
      setProjectPrompts(db, input)
      await migrate(db, dataRoot, input.projectId)
      return
    }
    setProjectPrompts(db, { ...input, general: input.general === previous ? null : input.general })
    await migrate(db, dataRoot, input.projectId)
  })
}
