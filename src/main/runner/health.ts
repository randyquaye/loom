import { statfs } from 'node:fs/promises'
import type { CloudHealth } from '../../shared/ipc-contract'

/** One data disk in the pilot; available blocks exclude the filesystem's reserved space. */
export async function cloudHealth(dataDir: string): Promise<CloudHealth> {
  const disk = await statfs(dataDir)
  const total = disk.blocks * disk.bsize
  const available = disk.bavail * disk.bsize
  return { disk: { total, available, warning: available < Math.max(2 * 1024 ** 3, total * 0.1) } }
}
