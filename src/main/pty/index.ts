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
interface Scrollback {
  chunks: string[]
  head: number
  offset: number
  length: number
  lineStart: boolean
}
const scrollback = new Map<string, Scrollback>()
let scrollbackLimit = 0

/**
 * Wired by a process whose terminals outlive the desktops watching them: each terminal then
 * keeps its most recent output, up to `limit` characters, for a desktop that connects later.
 */
export function keepScrollback(limit: number): void {
  scrollbackLimit = limit
}

function remember(id: string, data: string): void {
  if (scrollbackLimit === 0 || data === '') return
  const buffer = scrollback.get(id) ?? { chunks: [], head: 0, offset: 0, length: 0, lineStart: true }
  buffer.chunks.push(data)
  buffer.length += data.length
  while (buffer.length > scrollbackLimit) {
    const chunk = buffer.chunks[buffer.head]!
    const removed = Math.min(buffer.length - scrollbackLimit, chunk.length - buffer.offset)
    buffer.offset += removed
    buffer.length -= removed
    buffer.lineStart = chunk[buffer.offset - 1] === '\n'
    if (buffer.offset === chunk.length) {
      buffer.chunks[buffer.head++] = ''
      buffer.offset = 0
    }
  }
  if (buffer.head > 64 && buffer.head * 2 > buffer.chunks.length) {
    buffer.chunks.splice(0, buffer.head)
    buffer.head = 0
  }
  scrollback.set(id, buffer)
}

/** Join only when attaching; prefer a complete first line after the buffer was trimmed. */
function replay(id: string): string {
  const buffer = scrollback.get(id)
  if (buffer === undefined) return ''
  const chunks = buffer.chunks.slice(buffer.head)
  chunks[0] = (chunks[0] ?? '').slice(buffer.offset)
  let text = chunks.join('')
  if (!buffer.lineStart && text.includes('\n')) text = text.slice(text.indexOf('\n') + 1)
  const first = text.charCodeAt(0)
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text
}

/** The live terminals of one working directory, oldest first, with what they last printed. */
export function listTerminals(cwd: string): Array<{ id: string; scrollback: string }> {
  const live: Array<{ id: string; scrollback: string }> = []
  for (const [id, terminalCwd] of cwdById) {
    if (terminalCwd === cwd && sessions.has(id)) live.push({ id, scrollback: replay(id) })
  }
  return live
}
const cwdById = new Map<string, string>()
/** When a byte was last typed into, or printed by, a terminal of each working directory. */
const ioAt = new Map<string, number>()

function noteIo(id: string): void {
  const cwd = cwdById.get(id)
  if (cwd !== undefined) ioAt.set(cwd, Date.now())
}

export function terminalIoAt(cwd: string): number | undefined {
  return ioAt.get(cwd)
}
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
    noteIo(id)
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
  const terminal = sessions.get(id)
  if (terminal === undefined) return
  noteIo(id)
  terminal.pty.write(data)
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

/** A workspace stop destroys its terminal processes, while other workspaces stay attached. */
export function destroyTerminalsForCwd(cwd: string): void {
  ioAt.delete(cwd)
  for (const [id, directory] of cwdById) {
    if (directory !== cwd) continue
    destroyTerminal(id)
    sink?.(TERMINAL_EXIT_CHANNEL, { id, code: 0 })
  }
}
