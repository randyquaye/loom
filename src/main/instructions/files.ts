import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { InstructionScope } from '../../shared/ipc-contract'

export const INSTRUCTIONS_DIR = 'instructions'
export const MAX_INSTRUCTION_CHARS = 16_000

export class InstructionTooLongError extends Error {
  readonly code = 'INSTRUCTION_TOO_LONG'

  constructor(scope: InstructionScope, length: number) {
    super(
      `INSTRUCTION_TOO_LONG: ${scope} instructions are ${length} chars; the cap is ${MAX_INSTRUCTION_CHARS}`
    )
    this.name = 'InstructionTooLongError'
  }
}

/** Real markdown files under the data root, so they stay editable outside the app too. */
function fileFor(dataRoot: string, scope: InstructionScope, projectId: string | null): string {
  if (scope === 'project' && projectId === null) {
    throw new Error('project-scoped instructions need a projectId')
  }
  const name = scope === 'instance' ? 'INSTANCE.md' : `${projectId}.md`
  return path.join(dataRoot, INSTRUCTIONS_DIR, name)
}

function cap(text: string): string {
  return text.length > MAX_INSTRUCTION_CHARS ? text.slice(0, MAX_INSTRUCTION_CHARS) : text
}

export async function readInstructions(
  dataRoot: string,
  scope: InstructionScope,
  projectId: string | null
): Promise<string> {
  return cap(await readFile(fileFor(dataRoot, scope, projectId), 'utf8').catch(() => ''))
}

export async function writeInstructions(
  dataRoot: string,
  scope: InstructionScope,
  projectId: string | null,
  text: string
): Promise<void> {
  if (text.length > MAX_INSTRUCTION_CHARS) throw new InstructionTooLongError(scope, text.length)
  const file = fileFor(dataRoot, scope, projectId)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
}

/** Instance first, then project; blanks dropped. Each file is capped on read as well as write. */
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
