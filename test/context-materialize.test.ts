import { mkdtemp, readdir, readFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_CAP,
  attachmentFileName,
  writeAttachment,
  writeLoomContext
} from '../src/main/context/materialize'

describe('context materialization', () => {
  it('writes the workspace context blob agents are pointed at', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-ctx-'))

    await writeLoomContext(root, {
      workspaceName: 'ws',
      branch: 'loom/ws',
      repoPath: '/repo',
      backend: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      at: 0,
      envNames: []
    })

    const text = await readFile(path.join(root, '.context', 'loom.context'), 'utf8')
    expect(text).toContain('workspace: ws')
    expect(text).toContain('branch: loom/ws')
    expect(text).toContain('repository: /repo')
    expect(text).toContain('session agent: codex / gpt-6.1-sol / effort high')
  })

  it('names transcripts and terminal selections distinctly', () => {
    expect(attachmentFileName('transcript', 'Fix the thing!', 0)).toBe('Transcript of Fix-the-thing.md')
    expect(attachmentFileName('terminal', '', 0)).toMatch(/^terminal-selection-.*\.txt$/)
  })

  it('evicts the oldest attachments past the cap', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-ctx-cap-'))
    for (let i = 0; i < ATTACHMENT_CAP + 2; i++) {
      const rel = await writeAttachment(root, `t${i}.txt`, `body ${i}`)
      expect(rel).toBe(`.context/attachments/t${i}.txt`)
      // Distinct mtimes so eviction order is deterministic.
      await utimes(path.join(root, rel), (i + 1) * 1000, (i + 1) * 1000)
    }

    const left = await readdir(path.join(root, '.context', 'attachments'))

    expect(left).toHaveLength(ATTACHMENT_CAP)
    expect(left).not.toContain('t0.txt')
    expect(left).not.toContain('t1.txt')
    expect(left).toContain(`t${ATTACHMENT_CAP + 1}.txt`)
  })

  it('never evicts the comments mirror', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-ctx-comments-'))
    await writeAttachment(root, 'comments.md', '# Review comments\n')
    for (let i = 0; i < ATTACHMENT_CAP + 2; i++) {
      const rel = await writeAttachment(root, `t${i}.txt`, `body ${i}`)
      await utimes(path.join(root, rel), (i + 1) * 1000, (i + 1) * 1000)
    }

    const left = await readdir(path.join(root, '.context', 'attachments'))

    expect(left).toContain('comments.md')
    expect(left.filter((name) => name !== 'comments.md')).toHaveLength(ATTACHMENT_CAP)
  })
})
