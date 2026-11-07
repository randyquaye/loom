import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import {
  TERMINAL_DATA_CHANNEL,
  TERMINAL_EXIT_CHANNEL,
  type TerminalDataPush,
  type TerminalExitPush
} from '../../shared/ipc-contract'

type Sink = (channel: string, push: TerminalDataPush | TerminalExitPush) => void

let sink: Sink | null = null

/** Wired by main once the window exists; terminals push output through it. */
export function setTerminalSink(fn: Sink): void {
  sink = fn
}

const sessions = new Map<string, pty.IPty>()
const cwdById = new Map<string, string>()
/** The terminal the user is looking at, per working directory; run actions target it. */
const activeByCwd = new Map<string, string>()

export function setActiveTerminal(id: string): void {
  const cwd = cwdById.get(id)
  if (cwd !== undefined) activeByCwd.set(cwd, id)
}

export function createTerminal(cwd: string, extraEnv?: Record<string, string>): string {
  const id = randomUUID()
  const child = pty.spawn(process.env.SHELL ?? '/bin/zsh', [], {
    cwd,
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    env: { ...process.env, ...extraEnv } as Record<string, string>
  })
  child.onData((data) => {
    sink?.(TERMINAL_DATA_CHANNEL, { id, data })
  })
  child.onExit(({ exitCode }) => {
    sessions.delete(id)
    cwdById.delete(id)
    sink?.(TERMINAL_EXIT_CHANNEL, { id, code: exitCode })
  })
  sessions.set(id, child)
  cwdById.set(id, cwd)
  return id
}

/** The workspace terminal run actions write to: the visible tab, else the oldest live one. */
export function terminalIdForCwd(cwd: string): string | null {
  const active = activeByCwd.get(cwd)
  if (active !== undefined && sessions.has(active)) return active
  let fallback: string | null = null
  for (const [id, terminalCwd] of cwdById) {
    if (terminalCwd === cwd && sessions.has(id)) fallback = id
  }
  return fallback
}

export function writeTerminal(id: string, data: string): void {
  sessions.get(id)?.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  sessions.get(id)?.resize(cols, rows)
}

export function destroyTerminal(id: string): void {
  const child = sessions.get(id)
  if (child) {
    child.kill()
    sessions.delete(id)
    const cwd = cwdById.get(id)
    cwdById.delete(id)
    if (cwd !== undefined && activeByCwd.get(cwd) === id) activeByCwd.delete(cwd)
  }
}

export function destroyAllTerminals(): void {
  for (const id of [...sessions.keys()]) destroyTerminal(id)
}
