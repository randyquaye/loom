import { machineRuntime, type WorkspaceRuntime } from '../../runtime'
import { cleanTitle, titleInstruction } from '../../sessions/title'

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
  prompt: string,
  runtime: WorkspaceRuntime = machineRuntime
): Promise<string | null> {
  try {
    const { stdout } = await runtime.exec(bin, args, {
      input: `${titleInstruction(prompt)}\n`,
      timeoutMs: TITLE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES
    })
    return cleanTitle(stdout)
  } catch {
    return null
  }
}
