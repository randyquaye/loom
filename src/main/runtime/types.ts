import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { IPty } from 'node-pty'

export interface ProcessOpts {
  /** Omitted, the process starts wherever the runtime starts things by default. */
  cwd?: string | undefined
  /** Added to the environment the runtime already gives its processes. */
  env?: Record<string, string> | undefined
}

export interface ExecOpts extends ProcessOpts {
  /** Written to stdin, which is then closed. */
  input?: string | undefined
  timeoutMs?: number | undefined
  /** Combined stdout and stderr cap, in characters. */
  maxBuffer?: number | undefined
}

export interface ExecResult {
  stdout: string
  stderr: string
}

/** A long-lived process and the one correct way to stop it where it runs. */
export interface RuntimeProcess {
  readonly child: ChildProcessWithoutNullStreams
  /** Stops the whole process tree: SIGTERM first, SIGKILL once the grace period expires. */
  terminate(): void
}

export interface RuntimeTerminal {
  readonly pty: IPty
  /** Hangs up the shell and its jobs. */
  terminate(): void
}

/**
 * Answers one question for everything that executes on behalf of a workspace: where does
 * this process start? Agents, terminals, the setup script and tab titles all go through it,
 * so the same code runs a workspace on this machine or inside its container.
 */
export interface WorkspaceRuntime {
  /** Must have resolved before anything is started; a no-op on this machine. */
  ensureRunning(): Promise<void>
  /** Runs a command to completion; a non-zero exit, a timeout or too much output rejects. */
  exec(file: string, args: readonly string[], opts?: ExecOpts): Promise<ExecResult>
  spawn(file: string, args: readonly string[], opts?: ProcessOpts): RuntimeProcess
  openTerminal(opts?: ProcessOpts): RuntimeTerminal
  /** Removes the container and every process in it; files stay. A no-op on this machine. */
  stop(): Promise<void>
}
