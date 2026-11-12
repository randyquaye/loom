import { randomUUID } from 'node:crypto'
import {
  TERMINAL_DATA_CHANNEL,
  TERMINAL_EXIT_CHANNEL,
  type TerminalDataPush,
  type TerminalExitPush
} from '../../shared/ipc-contract'
import { machineRuntime, type RuntimeTerminal, type WorkspaceRuntime } from '../runtime'

type Sink = (channel: string, push: TerminalDataPush | TerminalExitPush) => void

let sink: Sink | null = null

/** Wired by main once the window exists; terminals push output through it. */
export function setTerminalSink(fn: Sink): void {
  sink = fn
}

const sessions = new Map<string, RuntimeTerminal>()
const scrollback = new Map<string, string>()
let scrollbackLimit = 0

/**
 * Wired by a process whose terminals outlive the desktops watching them: each terminal then
 * keeps its most recent output, up to `limit` characters, for a desktop that connects later.
 */
export function keepScrollback(limit: number): void {
  scrollbackLimit = limit
}

function remember(id: string, data: string): void {
  if (scrollbackLimit === 0) return
  const next = (scrollback.get(id) ?? '') + data
  scrollback.set(id, next.length > scrollbackLimit ? next.slice(-scrollbackLimit) : next)
}

/** The live terminals of one working directory, oldest first, with what they last printed. */
export function listTerminals(cwd: string): Array<{ id: string; scrollback: string }> {
  const live: Array<{ id: string; scrollback: string }> = []
  for (const [id, terminalCwd] of cwdById) {
    if (terminalCwd === cwd && sessions.has(id)) live.push({ id, scrollback: scrollback.get(id) ?? '' })
  }
  return live
}
const cwdById = new Map<string, string>()
/** The terminal the user is looking at, per working directory; run actions target it. */
const activeByCwd = new Map<string, string>()

export function setActiveTerminal(id: string): void {
  const cwd = cwdById.get(id)
  if (cwd !== undefined) activeByCwd.set(cwd, id)
}

/** The caller makes sure `runtime` is running first. */
export function createTerminal(
  cwd: string,
  extraEnv?: Record<string, string>,
  runtime: WorkspaceRuntime = machineRuntime
): string {
  const id = randomUUID()
  const terminal = runtime.openTerminal({ cwd, env: extraEnv })
  terminal.pty.onData((data) => {
    remember(id, data)
    sink?.(TERMINAL_DATA_CHANNEL, { id, data })
  })
  terminal.pty.onExit(({ exitCode }) => {
    sessions.delete(id)
    cwdById.delete(id)
    scrollback.delete(id)
    sink?.(TERMINAL_EXIT_CHANNEL, { id, code: exitCode })
  })
  sessions.set(id, terminal)
  cwdById.set(id, cwd)
  return id
}

/** The workspace terminal run actions write to: the visible tab, else the newest live one. */
export function terminalIdForCwd(cwd: string): string | null {
  const active = activeByCwd.get(cwd)
  if (active !== undefined && sessions.has(active)) return active
  let fallback: string | null = null
  for (const [id, terminalCwd] of cwdById) {
    if (terminalCwd === cwd && sessions.has(id)) fallback = id
  }
  return fallback
}

export function hasTerminal(id: string): boolean {
  return sessions.has(id)
}

export function writeTerminal(id: string, data: string): void {
  sessions.get(id)?.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  sessions.get(id)?.pty.resize(cols, rows)
}

export function destroyTerminal(id: string): void {
  const terminal = sessions.get(id)
  if (terminal) {
    terminal.terminate()
    sessions.delete(id)
    scrollback.delete(id)
    const cwd = cwdById.get(id)
    cwdById.delete(id)
    if (cwd !== undefined && activeByCwd.get(cwd) === id) activeByCwd.delete(cwd)
  }
}

export function destroyAllTerminals(): void {
  for (const id of [...sessions.keys()]) destroyTerminal(id)
}
