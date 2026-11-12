import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentEvent } from '../../../shared/events'
import { createEventQueue } from '../queue'
import type { RunningSession } from '../types'

export type LineParser = (line: string) => AgentEvent[]

const KILL_GRACE_MS = 2000
const STDERR_LIMIT = 8192
const UNKNOWN_TURN_ID = 'turn'

const ignoreLines: LineParser = () => []

/** Retains the same bounded diagnostic excerpt for every CLI transport. */
export function captureStderr(child: Pick<ChildProcess, 'stderr'>): () => string {
  let stderr = ''
  const stream = child.stderr
  if (stream) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.slice(0, STDERR_LIMIT - stderr.length)
    })
  }
  return () => stderr.trim()
}

interface ChildOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  spawnError: string | undefined
}

interface FinalizeCtx {
  tracker: TurnTracker
  binLabel: string
  cancelled: boolean
}

/**
 * One outcome→events policy shared by the one-shot and lazy CLI lifecycles, so
 * a signal-killed or failed child can never be reported as a clean end.
 */
function finalizeOutcome(result: ChildOutcome, ctx: FinalizeCtx): void {
  const { tracker, binLabel, cancelled } = ctx
  const turnId = tracker.turnId
  if (result.spawnError) {
    tracker.push({
      type: 'error',
      turnId,
      code: 'cli.spawn-failed',
      message: result.spawnError,
      retryable: false
    })
  } else if (cancelled) {
    if (!tracker.sawTurnDone) tracker.push({ type: 'turn.done', turnId, stopReason: 'cancelled' })
    return
  } else if (result.code !== 0 && result.code !== null) {
    tracker.push({
      type: 'error',
      turnId,
      code: `cli.exit-${result.code}`,
      message: result.stderr.length > 0 ? result.stderr : `${binLabel} exited with code ${result.code}`,
      retryable: false
    })
  } else if (result.signal) {
    tracker.push({
      type: 'error',
      turnId,
      code: `cli.signal-${result.signal}`,
      message: `${binLabel} was killed by ${result.signal}`,
      retryable: false
    })
  }
  if (!tracker.sawTurnDone && !cancelled) {
    const clean =
      result.spawnError === undefined && (result.code === 0 || result.code === null) && !result.signal
    tracker.push({ type: 'turn.done', turnId, stopReason: clean ? 'end' : 'error' })
  }
}

/** SIGTERM the whole process group first, SIGKILL once the grace period expires. */
export function terminateChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  // Children are spawned detached (own process group), so cancel must signal the
  // group; killing only the direct child would orphan grandchildren.
  const signalGroup = (sig: NodeJS.Signals): void => {
    if (pid === undefined) {
      child.kill(sig)
      return
    }
    try {
      process.kill(-pid, sig)
    } catch {
      child.kill(sig)
    }
  }
  signalGroup('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalGroup('SIGKILL')
  }, KILL_GRACE_MS)
  // Never hold the event loop open on behalf of a child that is already gone.
  timer.unref()
  child.once('close', () => clearTimeout(timer))
}

/**
 * Line-buffers stdout (records routinely straddle chunk boundaries) and feeds
 * each complete line to the parser. Resolves once the child has closed.
 */
function attachChild(
  child: ChildProcess,
  parseLine: LineParser,
  push: (event: AgentEvent) => void
): Promise<ChildOutcome> {
  let pending = ''
  const stderr = captureStderr(child)
  let spawnError: string | undefined
  let outcome: ChildOutcome | undefined
  let resolveOutcome: ((value: ChildOutcome) => void) | undefined

  const promise = new Promise<ChildOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  function settle(code: number | null, signal: NodeJS.Signals | null): void {
    if (outcome || !resolveOutcome) return
    if (pending.length > 0) {
      emitLine(pending)
      pending = ''
    }
    outcome = { code, signal, stderr: stderr(), spawnError }
    resolveOutcome(outcome)
  }

  function emitLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.length === 0) return
    for (const event of parseLine(line)) push(event)
  }

  const stdout = child.stdout
  if (stdout) {
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      pending += chunk
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        emitLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
      }
    })
  }

  child.once('error', (err: Error) => {
    spawnError = err.message
    // A failed execve may never emit 'close'; resolve anyway so callers are not stranded.
    settle(null, null)
  })
  child.once('close', (code, signal) => {
    // A failed execve can report 'error' after stdio has already closed, so give
    // it one tick before treating the exit as the final word.
    setImmediate(() => settle(code, signal))
  })

  return promise
}

export function spawnChild(
  bin: string,
  args: string[],
  cwd: string | undefined,
  extraEnv?: Record<string, string>
): ChildProcessWithoutNullStreams {
  return spawn(bin, args, {
    ...(cwd === undefined ? {} : { cwd }),
    // argv goes straight to execve: no shell, so no value can be re-read as shell
    // syntax no matter what the renderer put in it.
    shell: false,
    // Own process group so terminateChild can cancel the whole tree.
    detached: true,
    env: { ...process.env, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

interface TurnTracker {
  push(event: AgentEvent): void
  readonly turnId: string
  readonly sawTurnDone: boolean
}

/** Remembers the turn identity so synthetic terminal events join the same turn. */
function createTurnTracker(push: (event: AgentEvent) => void): TurnTracker {
  let turnId = UNKNOWN_TURN_ID
  let sawTurnDone = false
  return {
    push(event: AgentEvent): void {
      if ('turnId' in event && typeof event.turnId === 'string') turnId = event.turnId
      if (event.type === 'turn.done') sawTurnDone = true
      push(event)
    },
    get turnId(): string {
      return turnId
    },
    get sawTurnDone(): boolean {
      return sawTurnDone
    }
  }
}

function writeStdin(child: ChildProcess, text: string): Promise<void> {
  const stdin = child.stdin
  if (!stdin || stdin.destroyed) {
    return Promise.reject(new Error('CLI session stdin is closed'))
  }
  return new Promise<void>((resolve, reject) => {
    stdin.write(text, (err) => (err ? reject(err) : resolve()))
  })
}

/**
 * One-shot CLI session: spawns immediately and ends the event stream when the
 * child exits. Used directly by tests and by every lazy session turn.
 */
export function runCliSession(
  bin: string,
  args: string[],
  cwd: string,
  parseLine: LineParser = ignoreLines,
  extraEnv?: Record<string, string>
): RunningSession {
  const queue = createEventQueue()
  const tracker = createTurnTracker(queue.push)
  const child = spawnChild(bin, args, cwd, extraEnv)
  let cancelled = false

  const outcome = attachChild(child, parseLine, tracker.push).then((result) => {
    finish(result)
    queue.end()
    return result
  })

  function finish(result: ChildOutcome): void {
    finalizeOutcome(result, { tracker, binLabel: bin, cancelled })
  }

  return {
    async send(text: string): Promise<void> {
      await writeStdin(child, `${text}\n`)
    },
    async cancel(): Promise<void> {
      cancelled = true
      terminateChild(child)
      await outcome
    },
    async close(): Promise<void> {
      if (child.exitCode === null && child.signalCode === null) {
        cancelled = true
        terminateChild(child)
      }
      await outcome
    },
    events: queue.iterable
  }
}

export interface LazyCliPlan {
  args: string[]
  /** True when the prompt travels over stdin instead of inside argv. */
  promptOnStdin: boolean
}

export interface ProviderParser {
  parse(line: string): AgentEvent[]
  /** Provider-side session/thread id, once the stream has revealed it. */
  providerSessionId(): string | undefined
}

export interface LazyCliSpec {
  bin: string
  cwd: string
  /** Provider session to resume when this Loom session outlives the process. */
  initialProviderSessionId?: string | undefined
  /** LOOM_* workspace env merged into every turn's subprocess. */
  env?: Record<string, string> | undefined
  /** A fresh parser per turn, so each turn gets its own turn.started. */
  createParser(): ProviderParser
  plan(prompt: string, providerSessionId: string | undefined): LazyCliPlan
}

/**
 * Multi-turn CLI session. Each `send()` runs one subprocess: the first turn uses
 * the backend's fresh-session argv, later turns resume the provider session id
 * captured from the previous turn's stream.
 */
export function startLazyCliSession(spec: LazyCliSpec): RunningSession {
  const queue = createEventQueue()
  let providerSessionId = spec.initialProviderSessionId
  let inFlight: Promise<ChildOutcome> | undefined
  let activeChild: ChildProcess | undefined
  let cancelled = false
  let closed = false

  async function runTurn(prompt: string): Promise<void> {
    const plan = spec.plan(prompt, providerSessionId)
    const parser = spec.createParser()
    let turnDone: Extract<AgentEvent, { type: 'turn.done' }> | undefined
    // Provider completion can precede process exit. Hold the boundary until the
    // child is cleared, so consumers can immediately send the next queued turn.
    const tracker = createTurnTracker((event) => {
      if (event.type === 'turn.done') turnDone = event
      else queue.push(event)
    })
    const child = spawnChild(spec.bin, plan.args, spec.cwd, spec.env)
    activeChild = child

    const outcome = attachChild(child, parser.parse, (event) => {
      tracker.push(event)
      if (event.type === 'turn.started' && providerSessionId === undefined) {
        providerSessionId = parser.providerSessionId()
      }
    }).then((result) => {
      inFlight = undefined
      activeChild = undefined
      finishTurn(result, tracker, parser)
      if (turnDone) queue.push(turnDone)
      return result
    })

    inFlight = outcome
    if (plan.promptOnStdin) {
      await writeStdin(child, `${prompt}\n`).catch(() => undefined)
    }
    // The CLI must not block waiting on stdin once the prompt is delivered.
    child.stdin?.end()

    await outcome
  }

  function finishTurn(result: ChildOutcome, tracker: TurnTracker, parser: ProviderParser): void {
    if (providerSessionId === undefined) providerSessionId = parser.providerSessionId()
    finalizeOutcome(result, { tracker, binLabel: spec.bin, cancelled })
  }

  return {
    async send(text: string): Promise<void> {
      if (closed) throw new Error('CLI session is closed')
      if (inFlight) throw new Error('a CLI turn is already running; cancel it before sending')
      cancelled = false
      await runTurn(text)
    },
    async cancel(): Promise<void> {
      cancelled = true
      const child = activeChild
      if (child) terminateChild(child)
      const running = inFlight
      if (running) await running
    },
    async close(): Promise<void> {
      closed = true
      cancelled = true
      const child = activeChild
      if (child) terminateChild(child)
      const running = inFlight
      if (running) await running
      queue.end()
    },
    providerSessionId: () => providerSessionId,
    events: queue.iterable
  }
}
