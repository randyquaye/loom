import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BinaryFileError, languageFor, readFileJailed } from '../src/main/fs/read'
import { ContainmentError } from '../src/main/security/contain'

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-read-'))
  await mkdir(path.join(root, 'src'))
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await writeFile(path.join(root, 'blob.bin'), Buffer.from([0x50, 0x4b, 0x00, 0x01]))
  return root
}

describe('languageFor', () => {
  it.each([
    ['README.md', 'markdown'],
    ['a.json', 'json'],
    ['a.js', 'javascript'],
    ['a.ts', 'typescript'],
    ['a.tsx', 'typescript'],
    ['run.sh', 'shell'],
    ['a.py', 'python'],
    ['main.tf', 'hcl'],
    ['Makefile', 'plaintext'],
    ['a.rs', 'plaintext']
  ])('%s -> %s', (file, language) => {
    expect(languageFor(file)).toBe(language)
  })
})

describe('readFileJailed', () => {
  it('reads text with its language', async () => {
    const root = await makeRoot()
    expect(await readFileJailed(root, 'src/a.ts')).toEqual({
      text: 'export const a = 1\n',
      language: 'typescript'
    })
  })

  it('rejects binaries', async () => {
    const root = await makeRoot()
    await expect(readFileJailed(root, 'blob.bin')).rejects.toBeInstanceOf(BinaryFileError)
  })

  it('rejects relative escapes', async () => {
    const root = await makeRoot()
    await expect(readFileJailed(root, '../x')).rejects.toBeInstanceOf(ContainmentError)
  })

  it('rejects absolute paths outside the worktree', async () => {
    const root = await makeRoot()
    await expect(readFileJailed(root, '/etc/hosts')).rejects.toBeInstanceOf(ContainmentError)
  })
})
