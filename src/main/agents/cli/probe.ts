import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AuthStatus } from '../../../shared/models'

const execFileAsync = promisify(execFile)

/** argv array, no shell: `bin` is a compile-time constant, never renderer input. */
async function binaryOnPath(bin: string): Promise<boolean> {
  try {
    await execFileAsync('which', [bin])
    return true
  } catch {
    return false
  }
}

/**
 * codex and claude own their subscription credentials, so Loom can only observe
 * whether the CLI is installed. Absence is reported as needs-login because the
 * remedy is the same for the user: install the CLI and log in.
 */
export async function cliAuthStatus(bin: string, installHint: string): Promise<AuthStatus> {
  return (await binaryOnPath(bin)) ? { state: 'ready' } : { state: 'needs-login', hint: installHint }
}
