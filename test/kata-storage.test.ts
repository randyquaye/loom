import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { prepareKataDisk } from '../src/main/runtime/kata-storage'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'loom-kata-storage-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('preserves existing disk contents when startup is repeated with a different requested size', async () => {
  const storage = path.join(root, 'storage')
  await mkdir(storage)
  const disk = path.join(storage, 'docker.ext4')
  await writeFile(disk, 'previous workspace data; never format this during startup')
  expect(await prepareKataDisk(storage, 8)).toBe(disk)
  expect(await prepareKataDisk(storage, 16)).toBe(disk)
  expect(await readFile(disk, 'utf8')).toBe('previous workspace data; never format this during startup')
})

it('refuses redirected storage without modifying the file it points to', async () => {
  const outside = path.join(root, 'important')
  await writeFile(outside, 'keep')
  const storage = path.join(root, 'storage')
  await mkdir(storage)
  await symlink(outside, path.join(storage, 'docker.ext4'))
  await expect(prepareKataDisk(storage, 8)).rejects.toThrow(/symlink|symbolic/i)
  expect(await readFile(outside, 'utf8')).toBe('keep')
  const redirected = path.join(root, 'redirected')
  await symlink(storage, redirected)
  await expect(prepareKataDisk(redirected, 8)).rejects.toThrow(/symlink|symbolic/i)
  expect(await readFile(outside, 'utf8')).toBe('keep')
})
