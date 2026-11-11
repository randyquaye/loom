import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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

  it('preserves externally edited oversized project instructions for recovery', async () => {
    const root = await dataRoot()
    await mkdir(path.join(root, 'instructions'))
    const text = 'project guidance\n'.repeat(1800)
    await writeFile(path.join(root, 'instructions', 'p1.md'), text)

    expect(await readInstructions(root, 'project', 'p1')).toBe(text)
    await expect(writeInstructions(root, 'project', 'p1', text)).rejects.toBeInstanceOf(
      InstructionTooLongError
    )
    expect(await readInstructions(root, 'project', 'p1')).toBe(text)
  })

  it('allows consolidated project instructions without enlarging the instance cap', async () => {
    const root = await dataRoot()
    const text = 'x'.repeat(24_000)
    await writeInstructions(root, 'project', 'p1', text)

    expect(await readInstructions(root, 'project', 'p1')).toBe(text)
    await expect(writeInstructions(root, 'instance', null, text)).rejects.toBeInstanceOf(
      InstructionTooLongError
    )
  })

  it('reports unreadable instruction paths instead of pretending they are empty', async () => {
    const root = await dataRoot()
    await mkdir(path.join(root, 'instructions', 'p1.md'), { recursive: true })

    await expect(readInstructions(root, 'project', 'p1')).rejects.toMatchObject({ code: 'EISDIR' })
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
