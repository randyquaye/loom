import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import { REPOS_DIR } from '../src/shared/brand'
import type { ProjectRow } from '../src/shared/ipc-contract'
import { openDb } from '../src/main/db'
import { insertProject, repoPathTaken } from '../src/main/db/repos/projects'
import {
  deleteOwnedRepo,
  ProjectLocationExistsError,
  ProjectLocationRejectedError,
  resolveCloneTarget
} from '../src/main/git/projects'

const roots: string[] = []
const databases: Database.Database[] = []

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  while (databases.length > 0) databases.pop()?.close()
})

async function fixture(): Promise<{ dataRoot: string; repos: string; db: Database.Database }> {
  const dataRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'loom-proj-'))
  roots.push(dataRoot)
  const repos = path.join(dataRoot, REPOS_DIR)
  await mkdir(repos, { recursive: true })
  const db = openDb(':memory:')
  databases.push(db)
  return { dataRoot, repos, db }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

function projectRow(repoPath: string): ProjectRow {
  return {
    id: randomUUID(),
    name: path.basename(repoPath),
    repoPath,
    remoteUrl: null,
    createdAt: Date.now(),
    customPromptGeneral: null,
    customPromptCodeReview: null,
    customPromptFixErrors: null
  }
}

/** A folder left behind by a removed project: present on disk, referenced by no row. */
async function leftover(repos: string, name: string): Promise<string> {
  const target = path.join(repos, name)
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'README.md'), 'leftover\n', 'utf8')
  return target
}

describe('resolveCloneTarget', () => {
  it('leaves a missing target alone', async () => {
    const { dataRoot, repos, db } = await fixture()
    await resolveCloneTarget(dataRoot, path.join(repos, 'fresh'), false, (c) => repoPathTaken(db, c))
    expect(await exists(path.join(repos, 'fresh'))).toBe(false)
  })

  it('offers an app-owned leftover for overwrite instead of failing blind', async () => {
    const { dataRoot, repos, db } = await fixture()
    const target = await leftover(repos, 'chainalert-sentinel')
    const isTaken = (candidate: string): boolean => repoPathTaken(db, candidate)

    await expect(resolveCloneTarget(dataRoot, target, false, isTaken)).rejects.toBeInstanceOf(
      ProjectLocationExistsError
    )
    expect(await exists(target)).toBe(true)

    await resolveCloneTarget(dataRoot, target, true, isTaken)
    expect(await exists(target)).toBe(false)
  })

  it('never replaces a folder another project row references', async () => {
    const { dataRoot, repos, db } = await fixture()
    const target = await leftover(repos, 'live')
    insertProject(db, projectRow(target))
    const isTaken = (candidate: string): boolean => repoPathTaken(db, candidate)

    expect(isTaken(target)).toBe(true)
    await expect(resolveCloneTarget(dataRoot, target, true, isTaken)).rejects.toBeInstanceOf(
      ProjectLocationRejectedError
    )
    expect(await exists(target)).toBe(true)
  })

  it('never replaces folders outside the repos dir, overwrite or not', async () => {
    const { dataRoot, db } = await fixture()
    const target = await mkdtemp(path.join(dataRoot, 'mine-'))
    await writeFile(path.join(target, 'work.txt'), 'mine\n', 'utf8')
    const isTaken = (candidate: string): boolean => repoPathTaken(db, candidate)

    await expect(resolveCloneTarget(dataRoot, target, true, isTaken)).rejects.toBeInstanceOf(
      ProjectLocationRejectedError
    )
    expect(await exists(path.join(target, 'work.txt'))).toBe(true)
  })
})

describe('deleteOwnedRepo', () => {
  it('deletes an app-owned clone once its row is gone', async () => {
    const { dataRoot, repos, db } = await fixture()
    const target = await leftover(repos, 'gone')

    expect(await deleteOwnedRepo(dataRoot, target, (c) => repoPathTaken(db, c))).toBe(true)
    expect(await exists(target)).toBe(false)
  })

  it('keeps a clone another project row still points at', async () => {
    const { dataRoot, repos, db } = await fixture()
    const target = await leftover(repos, 'shared')
    insertProject(db, projectRow(target))

    expect(await deleteOwnedRepo(dataRoot, target, (c) => repoPathTaken(db, c))).toBe(false)
    expect(await exists(target)).toBe(true)
  })

  it('never touches adopted folders outside the repos dir', async () => {
    const { dataRoot, db } = await fixture()
    const target = await mkdtemp(path.join(dataRoot, 'adopted-'))

    expect(await deleteOwnedRepo(dataRoot, target, (c) => repoPathTaken(db, c))).toBe(false)
    expect(await exists(target)).toBe(true)
  })
})
