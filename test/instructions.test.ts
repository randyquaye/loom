import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  InstructionTooLongError,
  MAX_INSTRUCTION_CHARS,
  readInstructions,
  readInstructionOverlay,
  writeInstructions
} from '../src/main/instructions/files'

const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
})

async function dataRoot(): Promise<string> {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'loom-instr-'))
  roots.push(root)
  return root
}

describe('instruction files', () => {
  it('round-trips instance and project scopes as real files', async () => {
    const root = await dataRoot()
    await writeInstructions(root, 'instance', null, 'Always run the gates.')
    await writeInstructions(root, 'project', 'p1', 'Prefer small commits.')

    expect(await readInstructions(root, 'instance', null)).toBe('Always run the gates.')
    expect(await readInstructions(root, 'project', 'p1')).toBe('Prefer small commits.')
    expect(await readInstructions(root, 'project', 'p2')).toBe('')
  })

  it('refuses writes past the cap', async () => {
    const root = await dataRoot()
    const huge = 'x'.repeat(MAX_INSTRUCTION_CHARS + 1)
    await expect(writeInstructions(root, 'instance', null, huge)).rejects.toBeInstanceOf(
      InstructionTooLongError
    )
  })

  it('overlays instance first, then project, dropping blanks', async () => {
    const root = await dataRoot()
    await writeInstructions(root, 'project', 'p1', 'Project rules.')
    expect(await readInstructionOverlay(root, 'p1')).toEqual([{ scope: 'project', text: 'Project rules.' }])
    await writeInstructions(root, 'instance', null, 'Instance rules.')
    expect(await readInstructionOverlay(root, 'p1')).toEqual([
      { scope: 'instance', text: 'Instance rules.' },
      { scope: 'project', text: 'Project rules.' }
    ])
  })
})
