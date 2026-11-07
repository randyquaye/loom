import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface ToolResult {
  code: number
  stdout: string
  stderr: string
}

const TOOL_TIMEOUT_MS = 15_000
const TOOL_MAX_BUFFER = 4 * 1024 * 1024

/**
 * Runs a tool without a shell. A non-zero exit is a normal "found problems"
 * outcome for linters, so it resolves rather than rejects; only spawn
 * failures (missing binary, timeout) reject.
 */
export function runTool(file: string, args: readonly string[], cwd: string): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        shell: false,
        timeout: TOOL_TIMEOUT_MS,
        maxBuffer: TOOL_MAX_BUFFER,
        env: { ...process.env, CHECKPOINT_DISABLE: '1', PYTHONDONTWRITEBYTECODE: '1' }
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(error)
          return
        }
        resolve({ code: error === null ? 0 : Number(error.code), stdout, stderr })
      }
    )
  })
}

/**
 * Copies text into a fresh temp dir and runs fn there, so tools never see the
 * worktree (its configs, plugins or hooks) and cannot be steered by it.
 */
export async function withTempCopy<T>(
  fileName: string,
  text: string,
  fn: (dir: string, file: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'loom-lint-'))
  try {
    await writeFile(path.join(dir, fileName), text, 'utf8')
    return await fn(dir, fileName)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function findOnPath(
  name: string,
  envPath: string = process.env['PATH'] ?? ''
): Promise<string | null> {
  for (const dir of envPath.split(path.delimiter)) {
    if (dir === '') continue
    const candidate = path.join(dir, name)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}
