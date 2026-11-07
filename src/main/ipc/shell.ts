import { openExternalSafe } from '../shell/open'
import { handle } from './index'

/** Transcript links open in the OS default browser through the same allowlisted gate the
 * window-navigation lock uses; the renderer can never navigate the app window itself. */
export function registerShellIpc(): void {
  handle('shell:openExternal', async ({ url }) => {
    await openExternalSafe(url)
  })
}
