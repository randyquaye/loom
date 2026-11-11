import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { InstructionScope } from '../../shared/ipc-contract'
import { MAX_INSTANCE_INSTRUCTION_CHARS, MAX_PROJECT_INSTRUCTION_CHARS } from '../../shared/limits'

export const INSTRUCTIONS_DIR = 'instructions'
export const MAX_INSTRUCTION_CHARS = MAX_INSTANCE_INSTRUCTION_CHARS

export function instructionLimit(scope: InstructionScope): number {
  return scope === 'instance' ? MAX_INSTANCE_INSTRUCTION_CHARS : MAX_PROJECT_INSTRUCTION_CHARS
}

export class InstructionTooLongError extends Error {
  readonly code = 'INSTRUCTION_TOO_LONG'

  constructor(scope: InstructionScope, length: number) {
    super(
      `INSTRUCTION_TOO_LONG: ${scope} instructions are ${length} chars; the cap is ${instructionLimit(scope)}`
    )
    this.name = 'InstructionTooLongError'
  }
}

/** Real markdown files under the data root, so they stay editable outside the app too. */
export function instructionFile(dataRoot: string, scope: InstructionScope, projectId: string | null): string {
  if (scope === 'project' && projectId === null) {
    throw new Error('project-scoped instructions need a projectId')
  }
  const name = scope === 'instance' ? 'INSTANCE.md' : `${projectId}.md`
  return path.join(dataRoot, INSTRUCTIONS_DIR, name)
}

export async function readInstructions(
  dataRoot: string,
  scope: InstructionScope,
  projectId: string | null
): Promise<string> {
  try {
    return await readFile(instructionFile(dataRoot, scope, projectId), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

/** Replace a complete file only after its contents are durable; keep failed writes recoverable. */
export async function writeTextAtomically(file: string, text: string): Promise<void> {
  const dir = path.dirname(file)
  await mkdir(dir, { recursive: true })
  const temporary = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, file)
    const directory = await open(dir, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function writeInstructions(
  dataRoot: string,
  scope: InstructionScope,
  projectId: string | null,
  text: string
): Promise<void> {
  if (text.length > instructionLimit(scope)) throw new InstructionTooLongError(scope, text.length)
  await writeTextAtomically(instructionFile(dataRoot, scope, projectId), text)
}

/** Instance first, then project; blanks dropped, original text retained for validation and recovery. */
export async function readInstructionOverlay(
  dataRoot: string,
  projectId: string
): Promise<Array<{ scope: InstructionScope; text: string }>> {
  const [instance, project] = await Promise.all([
    readInstructions(dataRoot, 'instance', null),
    readInstructions(dataRoot, 'project', projectId)
  ])
  const overlay: Array<{ scope: InstructionScope; text: string }> = []
  if (instance.trim() !== '') overlay.push({ scope: 'instance', text: instance })
  if (project.trim() !== '') overlay.push({ scope: 'project', text: project })
  return overlay
}
