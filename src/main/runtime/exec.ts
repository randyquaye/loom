import type { ExecOpts, ExecResult, RuntimeProcess } from './types'

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024

export class ExecError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly code: number | null
  ) {
    super(message)
    this.name = 'ExecError'
  }
}

/**
 * Runs an already started process to completion. Shared by both runtimes so that a timeout
 * stops the process through its own `terminate`, which is the only stop that reaches inside
 * a container. `maxBuffer` is a byte limit on each of stdout and stderr, as with execFile.
 */
export function collect(proc: RuntimeProcess, label: string, opts: ExecOpts = {}): Promise<ExecResult> {
  const { child } = proc
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER
  return new Promise((resolve, reject) => {
    const kept = { stdout: '', stderr: '' }
    const bytes = { stdout: 0, stderr: 0 }
    let stopped: string | undefined
    const stop = (reason: string): void => {
      if (stopped !== undefined) return
      stopped = reason
      proc.terminate()
    }
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => stop(`timed out after ${opts.timeoutMs} ms`), opts.timeoutMs)
    // Output is still read after a stop, so the process cannot block on a full pipe, but it
    // is no longer kept: a process that ignores the stop must not be able to fill memory.
    const take = (stream: 'stdout' | 'stderr') => (chunk: string) => {
      if (stopped !== undefined) return
      bytes[stream] += Buffer.byteLength(chunk)
      kept[stream] += chunk
      if (bytes[stream] > maxBuffer) stop(`produced more than ${maxBuffer} bytes on ${stream}`)
    }
    child.stdout.setEncoding('utf8').on('data', take('stdout'))
    child.stderr.setEncoding('utf8').on('data', take('stderr'))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(new ExecError(`${label}: ${error.message}`, kept.stdout, kept.stderr, null))
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (stopped === undefined && code === 0) return resolve(kept)
      const why = stopped ?? (signal === null ? `exited with code ${code}` : `was killed by ${signal}`)
      reject(new ExecError(`${label} ${why}`, kept.stdout, kept.stderr, code))
    })
    // A process that exits without reading its input closes the pipe under the write.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
}
