import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Only this disk file is exported to the guest, never its host-owned parent directory. */
export async function prepareKataDisk(storagePath: string, sizeGb: number): Promise<string> {
  if (!Number.isInteger(sizeGb) || sizeGb < 4 || sizeGb > 256) {
    throw new Error('LOOM_WORKSPACE_DOCKER_DISK_GB must be an integer between 4 and 256')
  }
  await mkdir(storagePath, { recursive: true, mode: 0o700 })
  const directory = await lstat(storagePath)
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error('Kata storage must be a directory, not a symlink')
  }
  const disk = path.join(storagePath, 'docker.ext4')
  const existing = await lstat(disk).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing !== null) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Kata disk must be a regular file, not a symlink')
    }
    // Existing data is never reformatted or resized as a side effect of starting compute.
    return disk
  }
  const temporary = path.join(storagePath, `${randomUUID()}.creating`)
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.truncate(sizeGb * 1024 ** 3)
    } finally {
      await file.close()
    }
    await run('mkfs.ext4', ['-q', '-F', '-m', '0', temporary], { timeout: 60_000 })
    // link cannot replace a disk another starter published. A partial format is never exposed.
    await link(temporary, disk).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
  } finally {
    await rm(temporary, { force: true })
  }
  return disk
}
