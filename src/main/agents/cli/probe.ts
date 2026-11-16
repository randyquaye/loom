import { execFile, type ExecFileException } from 'node:child_process'
import { promisify } from 'node:util'
import type { AuthStatus } from '../../../shared/models'

const execFileAsync = promisify(execFile)

/** Only the CLI's explicit signed-out response means the person needs to log in. */
function signedOut(bin: 'codex' | 'claude', failure: ExecFileException): boolean {
  if (failure.code !== 1 || failure.killed) return false
  if (bin === 'codex')
    return [failure.stdout, failure.stderr].some((text) => text?.toString().trim() === 'Not logged in')
  try {
    return (JSON.parse(failure.stdout?.toString() ?? '') as { loggedIn?: unknown } | null)?.loggedIn === false
  } catch {
    return false
  }
}

/** Credentials stay with the CLI; these commands inspect sign-in without starting a session. */
export async function cliAuthStatus(
  bin: 'codex' | 'claude',
  installHint: string,
  exec = execFileAsync
): Promise<AuthStatus> {
  try {
    await exec(bin, bin === 'codex' ? ['login', 'status'] : ['auth', 'status'], {
      timeout: 5000,
      maxBuffer: 64 * 1024
    })
    return { state: 'ready' }
  } catch (error) {
    const failure = error as ExecFileException
    if (failure.code === 'ENOENT') return { state: 'not-installed', hint: installHint }
    if (signedOut(bin, failure))
      return {
        state: 'needs-login',
        hint: `Run \`${bin === 'codex' ? 'codex login' : 'claude auth login'}\` in Terminal to sign in.`
      }
    return { state: 'error', message: 'Could not check sign-in. Update the CLI or try again.' }
  }
}
