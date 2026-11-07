import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ContainmentError } from '../src/main/security/contain'
import { listDir } from '../src/main/fs/tree'

async function touch(root: string, rel: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await writeFile(path.join(root, rel), 'x')
}

describe('listDir', () => {
  it('lists one level, dirs first, skips .git and node_modules, keeps dot dirs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-tree-'))
    const files = [
      'b.ts',
      'a.md',
      'src/z.ts',
      'src/lib/y.ts',
      '.git/HEAD',
      'node_modules/p/i.js',
      '.context/n.md'
    ]
    for (const rel of files) await touch(root, rel)

    const nodes = await listDir(root, '')

    expect(nodes.map((n) => [n.name, n.kind])).toEqual([
      ['.context', 'dir'],
      ['src', 'dir'],
      ['a.md', 'file'],
      ['b.ts', 'file']
    ])
    // Directories carry no children: the renderer expands them lazily.
    expect(nodes.every((n) => n.children === undefined)).toBe(true)

    const src = await listDir(root, 'src')
    expect(src.map((n) => [n.name, n.kind, n.path])).toEqual([
      ['lib', 'dir', 'src/lib'],
      ['z.ts', 'file', 'src/z.ts']
    ])
  })

  it('lists symlinked dirs as leaves and never follows them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-tree-link-'))
    await touch(root, 'src/a.ts')
    await symlink(path.join(root, 'src'), path.join(root, 'link'))

    const nodes = await listDir(root, '')

    expect(nodes.find((n) => n.name === 'link')).toEqual({ name: 'link', path: 'link', kind: 'file' })
  })

  it('caps a single listing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-tree-cap-'))
    for (let i = 0; i < 30; i++) await touch(root, `f${String(i).padStart(2, '0')}.txt`)

    expect(await listDir(root, '', 25)).toHaveLength(25)
  })

  it('refuses paths outside the worktree', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-tree-jail-'))
    await touch(root, 'a.ts')

    await expect(listDir(root, '../x')).rejects.toBeInstanceOf(ContainmentError)
    await expect(listDir(root, '/etc')).rejects.toBeInstanceOf(ContainmentError)
  })
})
