import { mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ATTACH_MAX_LINES,
  AttachmentError,
  formatAttachment,
  readAttachment,
  resolveAttachment
} from '../src/main/sessions/attachments'

const roots: string[] = []
let worktree = ''
let outside = ''
let denied = ''

async function tempdir(tag: string): Promise<string> {
  const dir = await mkdtemp(path.join(await realpath(tmpdir()), tag))
  roots.push(dir)
  return dir
}

beforeAll(async () => {
  worktree = await tempdir('loom-attach-wt-')
  outside = await tempdir('loom-attach-out-')
  denied = await tempdir('loom-attach-denied-')
  await writeFile(path.join(worktree, 'notes.txt'), 'hello world\nsecond line\n')
  await writeFile(path.join(worktree, '.env'), 'SECRET=1\n')
  await writeFile(path.join(worktree, 'fenced.md'), '```js\nconsole.log(1)\n```\n')
  await writeFile(path.join(outside, 'outside.txt'), 'from outside the worktree\n')
  await writeFile(path.join(outside, 'blob.bin'), Buffer.from([1, 0, 2, 0]))
  await writeFile(path.join(outside, 'long.txt'), `${'line\n'.repeat(ATTACH_MAX_LINES + 500)}`)
  await writeFile(path.join(denied, 'secrets.enc'), 'x')
  // A friendly name inside the worktree that points outside it.
  await symlink(path.join(outside, 'outside.txt'), path.join(worktree, 'link-out'))
})

afterAll(async () => {
  await Promise.all(roots.map((root) => realpath(root).catch(() => root)))
})

describe('resolveAttachment', () => {
  it('jails relative paths to the worktree', async () => {
    const resolved = await resolveAttachment(worktree, 'notes.txt')
    expect(resolved.label).toBe('notes.txt')
    expect(resolved.abs.endsWith('notes.txt')).toBe(true)
  })

  it('refuses relative escapes', async () => {
    await expect(resolveAttachment(worktree, '../outside.txt')).rejects.toThrow()
  })

  it('refuses a symlink that leaves the worktree', async () => {
    await expect(resolveAttachment(worktree, 'link-out')).rejects.toThrow()
  })

  it('refuses credential-shaped names even inside the worktree', async () => {
    await expect(resolveAttachment(worktree, '.env')).rejects.toBeInstanceOf(AttachmentError)
  })

  it('allows absolute paths outside the worktree', async () => {
    const target = path.join(outside, 'outside.txt')
    const resolved = await resolveAttachment(worktree, target)
    expect(resolved.label).toBe(target)
  })

  it('refuses absolute paths under a denied root', async () => {
    await expect(
      resolveAttachment(worktree, path.join(denied, 'secrets.enc'), [denied])
    ).rejects.toBeInstanceOf(AttachmentError)
  })

  it('refuses absolute paths that do not exist', async () => {
    await expect(resolveAttachment(worktree, path.join(outside, 'nope.txt'))).rejects.toBeInstanceOf(
      AttachmentError
    )
  })
})

describe('readAttachment', () => {
  it('reads text with line and byte counts', async () => {
    const content = await readAttachment(path.join(worktree, 'notes.txt'))
    expect(content.text).toBe('hello world\nsecond line\n')
    expect(content.lines).toBe(3)
    expect(content.truncated).toBe(false)
  })

  it('truncates past the line cap and says so', async () => {
    const content = await readAttachment(path.join(outside, 'long.txt'))
    expect(content.truncated).toBe(true)
    expect(content.text.split('\n')).toHaveLength(ATTACH_MAX_LINES)
  })

  it('refuses binary files', async () => {
    await expect(readAttachment(path.join(outside, 'blob.bin'))).rejects.toBeInstanceOf(AttachmentError)
  })

  it('refuses directories', async () => {
    await expect(readAttachment(outside)).rejects.toBeInstanceOf(AttachmentError)
  })
})

describe('formatAttachment', () => {
  it('names the file and fences the content', () => {
    const block = formatAttachment('notes.txt', {
      text: 'hello world',
      lines: 1,
      bytes: 11,
      truncated: false
    })
    expect(block.startsWith('<attached file: notes.txt — 1 lines,')).toBe(true)
    expect(block).toContain('```\nhello world\n```')
  })

  it('lengthens the fence when the content contains one', () => {
    const block = formatAttachment('fenced.md', {
      text: '```js\ncode\n```',
      lines: 3,
      bytes: 13,
      truncated: false
    })
    expect(block).toContain('````\n```js')
  })

  it('notes truncation in the header', () => {
    const block = formatAttachment('long.txt', { text: 'x', lines: 9000, bytes: 1, truncated: true })
    expect(block).toContain('truncated to first 4000 lines')
  })
})
