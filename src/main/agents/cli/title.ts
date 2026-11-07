import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cleanTitle, titleInstruction } from '../../sessions/title'

const execFileAsync = promisify(execFile)

const TITLE_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * One throwaway one-shot invocation names the session. The instruction goes over stdin so
 * the user's prompt never lands in argv. Any failure — an unfamiliar flag, a timeout,
 * churn in CLI output — degrades to the excerpt title rather than touching the turn.
 */
export async function cliSessionTitle(
  bin: string,
  args: readonly string[],
  prompt: string
): Promise<string | null> {
  try {
    const pending = execFileAsync(bin, [...args], {
      shell: false,
      timeout: TITLE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES
    })
    pending.child.stdin?.end(`${titleInstruction(prompt)}\n`)
    const { stdout } = await pending
    return cleanTitle(stdout)
  } catch {
    return null
  }
}
