import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import type * as Fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/main/db'
import { readInstructions } from '../src/main/instructions/files'
import { migrateProjectInstructions } from '../src/main/instructions/migrate-general'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const roots: string[] = []
const databases: Database.Database[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.clearAllMocks()
})

async function fixture(projectText: string, general: string) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'loom-general-'))
  roots.push(root)
  const db = openDb(':memory:')
  databases.push(db)
  db.prepare(
    'INSERT INTO projects (id, name, repo_path, created_at, custom_prompt_general) VALUES (?, ?, ?, ?, ?)'
  ).run('p1', 'demo', '/tmp/demo', 1, general)
  await mkdir(path.join(root, 'instructions'))
  const file = path.join(root, 'instructions', 'p1.md')
  await writeFile(file, projectText)
  return { db, root, file }
}

function generalText(db: Database.Database): string | null {
  return (
    db.prepare('SELECT custom_prompt_general AS text FROM projects WHERE id = ?').get('p1') as {
      text: string | null
    }
  ).text
}

function blockClear(db: Database.Database): void {
  db.exec(`CREATE TRIGGER block_general_clear BEFORE UPDATE OF custom_prompt_general ON projects
    WHEN NEW.custom_prompt_general IS NULL BEGIN SELECT RAISE(ABORT, 'clear failed'); END`)
}

describe('General instruction consolidation', () => {
  it('preserves both sources byte-for-byte and clears General only after merging', async () => {
    const project = '  Project rules.\r\n'
    const general = '\n General rules.  \n'
    const { db, root } = await fixture(project, general)

    await migrateProjectInstructions(db, root, 'p1')

    expect(await readInstructions(root, 'project', 'p1')).toBe(`${project}\n\n${general}`)
    expect(generalText(db)).toBeNull()
    await migrateProjectInstructions(db, root, 'p1')
    expect(await readInstructions(root, 'project', 'p1')).toBe(`${project}\n\n${general}`)
  })

  it('retries a failed database clear without duplicating a successful file write', async () => {
    const general = 'Repeated general rules.'
    const { db, root } = await fixture(`Project already mentions ${general}`, general)
    blockClear(db)

    await expect(migrateProjectInstructions(db, root, 'p1')).rejects.toThrow('clear failed')
    const merged = await readInstructions(root, 'project', 'p1')
    expect(merged).toBe(`Project already mentions ${general}\n\n${general}`)
    expect(generalText(db)).toBe(general)
    db.exec('DROP TRIGGER block_general_clear')

    await migrateProjectInstructions(db, root, 'p1')

    expect(await readInstructions(root, 'project', 'p1')).toBe(merged)
    expect(generalText(db)).toBeNull()
  })

  it('preserves unexpected project edits after a partially completed migration', async () => {
    const general = 'General rules.'
    const { db, root, file } = await fixture('Project rules.', general)
    blockClear(db)
    await expect(migrateProjectInstructions(db, root, 'p1')).rejects.toThrow('clear failed')
    db.exec('DROP TRIGGER block_general_clear')
    await writeFile(file, 'Someone edited the project instructions.')

    await expect(migrateProjectInstructions(db, root, 'p1')).rejects.toThrow(/changed|recovery/i)

    expect(await readFile(file, 'utf8')).toBe('Someone edited the project instructions.')
    expect(generalText(db)).toBe(general)
  })

  it('keeps both originals when their combined text exceeds the project limit', async () => {
    const project = 'p'.repeat(16_000)
    const general = 'g'.repeat(9000)
    const { db, root, file } = await fixture(project, general)

    await expect(migrateProjectInstructions(db, root, 'p1')).rejects.toThrow(/too.long|cap/i)

    expect(await readFile(file, 'utf8')).toBe(project)
    expect(generalText(db)).toBe(general)
  })

  it('keeps General when the existing instruction path cannot be read', async () => {
    const general = 'General rules.'
    const { db, root, file } = await fixture('Project rules.', general)
    await rm(file)
    await mkdir(file)

    await expect(migrateProjectInstructions(db, root, 'p1')).rejects.toMatchObject({ code: 'EISDIR' })

    expect(generalText(db)).toBe(general)
  })

  it('keeps both originals when the atomic replacement fails', async () => {
    const project = 'Project rules.'
    const general = 'General rules.'
    const { db, root, file } = await fixture(project, general)
    const actual = await vi.importActual<typeof Fs>('node:fs/promises')
    vi.mocked(rename).mockImplementationOnce(actual.rename)
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('write denied'), { code: 'EACCES' }))

    await expect(migrateProjectInstructions(db, root, 'p1')).rejects.toThrow('write denied')

    expect(await readFile(file, 'utf8')).toBe(project)
    expect(generalText(db)).toBe(general)
  })
})
