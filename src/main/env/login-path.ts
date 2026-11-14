import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const MARKER = '__LOOM_PATH__'
/** Long enough for a heavy zsh setup; a hung rc file must not hold startup hostage. */
const SHELL_WAIT_MS = 3000

/** Where agent CLI installers put binaries; searched even when the login shell cannot be read. */
function commonBinDirs(home: string): string[] {
  return [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']
}

/** PATH lists joined in priority order, without empties or repeats. */
function mergePath(...lists: (string | null | undefined)[]): string {
  const dirs = new Set<string>()
  for (const list of lists) {
    for (const dir of (list ?? '').split(path.delimiter)) if (dir !== '') dirs.add(dir)
  }
  return [...dirs].join(path.delimiter)
}

/**
 * The PATH an interactive login shell builds, rc files included. The value is fenced by markers
 * because rc files may print banners around it; null when the shell fails or times out.
 */
function loginShellPath(shell: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`],
      { env, encoding: 'utf8' },
      (_error, stdout) => {
        clearTimeout(timer)
        const match = new RegExp(`${MARKER}([\\s\\S]*?)${MARKER}`).exec(stdout)
        resolve(match?.[1] ?? null)
      }
    )
    // Own timer rather than execFile's: anything an rc file started can hold stdout open after
    // the shell itself is killed, and that must not stall startup.
    const timer = setTimeout(() => {
      child.kill()
      resolve(null)
    }, timeoutMs)
  })
}

/**
 * An app opened from the Dock, Finder or Spotlight gets launchd's bare PATH, so CLIs installed in
 * ~/.local/bin or Homebrew are invisible and every agent spawn fails with ENOENT. Rebuilds PATH
 * once at startup: the login shell's own PATH first, then what the app was launched with, then
 * the usual install folders for when the shell cannot be read.
 */
export async function adoptLoginPath(
  env: NodeJS.ProcessEnv = process.env,
  { timeoutMs = SHELL_WAIT_MS }: { timeoutMs?: number } = {}
): Promise<void> {
  if (process.platform === 'win32') return
  const fromShell = await loginShellPath(env.SHELL ?? '/bin/zsh', env, timeoutMs)
  const fallback = commonBinDirs(env.HOME ?? os.homedir()).join(path.delimiter)
  env.PATH = mergePath(fromShell, env.PATH, fallback)
}
