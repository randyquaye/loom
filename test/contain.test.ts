import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { contain, ContainmentError } from '../src/main/security/contain'

async function makeRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'loom-contain-'))
  await mkdir(path.join(root, 'src'), { recursive: true })
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  return root
}

describe('contain', () => {
  it('resolves nested paths inside the root', async () => {
    const root = await makeRoot()
    expect(await contain(root, 'src/a.ts')).toBe(path.join(await realpath(root), 'src', 'a.ts'))
  })

  it('allows paths that do not exist yet', async () => {
    const root = await makeRoot()
    expect(await contain(root, 'src/new/b.ts')).toBe(path.join(await realpath(root), 'src', 'new', 'b.ts'))
  })

  it('rejects relative escapes', async () => {
    const root = await makeRoot()
    await expect(contain(root, '../escape')).rejects.toThrow(ContainmentError)
  })

  it('rejects absolute escapes', async () => {
    const root = await makeRoot()
    await expect(contain(root, '/etc/passwd')).rejects.toThrow(ContainmentError)
  })

  it('rejects symlinked escapes', async () => {
    const root = await makeRoot()
    const outside = await mkdtemp(path.join(tmpdir(), 'loom-outside-'))
    await symlink(outside, path.join(root, 'link'))
    await expect(contain(root, 'link/secret')).rejects.toThrow(ContainmentError)
  })
})
