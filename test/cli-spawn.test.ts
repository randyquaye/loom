import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODEX_FALLBACK_TURN_ID, createCodexParser } from '../src/main/agents/cli/parse-codex'
import { runCliSession, startLazyCliSession, type LineParser } from '../src/main/agents/cli/spawn'
import type { RunningSession } from '../src/main/agents/types'
import type { AgentEvent } from '../src/shared/events'

const CAT = '/bin/cat'
const MISSING_BIN = '/bin/loom-test-binary-that-does-not-exist'
const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/codex-exec-sample.jsonl', import.meta.url))
const THREAD = '019c1f3a-7d2b-4a51-9c0e-2b6f8a4d1e77'

/** Echoes each buffered line back as a text.delta so splitting is observable. */
const echoLines: LineParser = (line) => [{ type: 'text.delta', turnId: 't', text: line }]

let workDir = ''

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'loom-cli-spawn-'))
})

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true })
})

interface Collector {
  events: AgentEvent[]
  done: Promise<void>
}

function startCollecting(session: RunningSession): Collector {
  const events: AgentEvent[] = []
  const done = (async () => {
    for await (const event of session.events) events.push(event)
  })()
  return { events, done }
}

async function until(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function textOf(events: AgentEvent[]): string[] {
  return events
    .filter((e): e is AgentEvent & { type: 'text.delta' } => e.type === 'text.delta')
    .map((e) => e.text)
}

describe('runCliSession line buffering', () => {
  it('splits a single multi-line chunk into one parse per line, in order', async () => {
    const session = runCliSession(CAT, [CODEX_FIXTURE], workDir, echoLines)
    const collector = startCollecting(session)
    await collector.done

    const expected = (await readFile(CODEX_FIXTURE, 'utf8')).split('\n').filter((l) => l.length > 0)
    expect(expected.length).toBeGreaterThanOrEqual(10)
    expect(textOf(collector.events)).toEqual(expected)
  })

  it('reassembles a record that straddles many pipe chunks', async () => {
    // Well past the 64KiB pipe buffer, so cat cannot deliver this in one chunk.
    const filler = 'x'.repeat(200_000)
    const line = JSON.stringify({
      type: 'item.completed',
      id: 'big',
      item: { type: 'agent_message', id: 'big', text: filler }
    })
    const file = path.join(workDir, 'one-huge-line.jsonl')
    await writeFile(file, `${line}\n`, 'utf8')

    const parser = createCodexParser(CODEX_FALLBACK_TURN_ID)
    const session = runCliSession(CAT, [file], workDir, (raw) => parser.parse(raw))
    const collector = startCollecting(session)
    await collector.done

    const done = collector.events.filter((e) => e.type === 'text.done')
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ type: 'text.done', turnId: CODEX_FALLBACK_TURN_ID, text: filler })
  })

  it('handles CRLF line endings', async () => {
    const file = path.join(workDir, 'crlf.jsonl')
    await writeFile(file, '{"type":"turn.started"}\r\n{"type":"turn.completed"}\r\n', 'utf8')

    const session = runCliSession(CAT, [file], workDir, echoLines)
    const collector = startCollecting(session)
    await collector.done

    expect(textOf(collector.events)).toEqual(['{"type":"turn.started"}', '{"type":"turn.completed"}'])
  })

  it('flushes a trailing record that has no final newline', async () => {
    const file = path.join(workDir, 'no-trailing-newline.jsonl')
    await writeFile(file, '{"type":"turn.started"}\n{"type":"turn.completed"}', 'utf8')

    const session = runCliSession(CAT, [file], workDir, echoLines)
    const collector = startCollecting(session)
    await collector.done

    expect(textOf(collector.events)).toEqual(['{"type":"turn.started"}', '{"type":"turn.completed"}'])
  })
})

describe('runCliSession event ordering over stdin', () => {
  it('preserves the order of successive sends', async () => {
    const session = runCliSession(CAT, [], workDir, echoLines)
    const collector = startCollecting(session)

    await session.send('alpha')
    await session.send('beta')
    await session.send('gamma')
    await until(() => collector.events.length >= 3, 'three echoed lines')

    expect(textOf(collector.events).slice(0, 3)).toEqual(['alpha', 'beta', 'gamma'])
    await session.cancel()
    await collector.done
  })

  it('rejects a send once stdin has been closed', async () => {
    const session = runCliSession(CAT, [], workDir, echoLines)
    const collector = startCollecting(session)
    await session.cancel()
    await collector.done
    await expect(session.send('after exit')).rejects.toThrow()
  })
})

describe('runCliSession terminal events', () => {
  it('ends the stream with a clean turn.done when the child exits on its own', async () => {
    const parser = createCodexParser(THREAD)
    const session = runCliSession(CAT, [CODEX_FIXTURE], workDir, (line) => parser.parse(line))
    const collector = startCollecting(session)
    await collector.done

    expect(collector.events[0]).toMatchObject({ type: 'turn.started', turnId: THREAD })
    expect(collector.events.at(-1)).toEqual({ type: 'turn.done', turnId: THREAD, stopReason: 'end' })
    expect(collector.events.filter((e) => e.type === 'turn.done')).toHaveLength(1)
  })

  it('reports cancel() as a cancelled turn and terminates the iterable', async () => {
    const session = runCliSession(CAT, [], workDir, echoLines)
    const collector = startCollecting(session)

    await session.send('still running')
    await until(() => collector.events.length >= 1, 'the echo to arrive')
    await session.cancel()
    await collector.done

    expect(collector.events.at(-1)).toEqual({ type: 'turn.done', turnId: 't', stopReason: 'cancelled' })
  })

  it('reports a binary that cannot be executed as a spawn error', async () => {
    const session = runCliSession(MISSING_BIN, [], workDir, echoLines)
    const collector = startCollecting(session)
    await collector.done

    expect(collector.events[0]).toMatchObject({ type: 'error', code: 'cli.spawn-failed', retryable: false })
    expect(collector.events.at(-1)).toMatchObject({ type: 'turn.done', stopReason: 'error' })
  })

  it('reports a non-zero exit with the captured stderr', async () => {
    const session = runCliSession(CAT, [path.join(workDir, 'nope-does-not-exist.jsonl')], workDir, echoLines)
    const collector = startCollecting(session)
    await collector.done

    const error = collector.events.find((e) => e.type === 'error')
    expect(error).toMatchObject({ type: 'error', retryable: false })
    expect(error && 'message' in error ? error.message : '').toContain('nope-does-not-exist.jsonl')
    expect(error && 'code' in error ? error.code : '').toMatch(/^cli\.exit-\d+$/)
    expect(collector.events.at(-1)).toMatchObject({ type: 'turn.done', stopReason: 'error' })
  })

  it('surfaces a malformed record as an error event without killing the stream', async () => {
    const file = path.join(workDir, 'malformed.jsonl')
    await writeFile(file, '{"type":"turn.started"}\nnot json at all\n{"type":"turn.completed"}\n', 'utf8')

    const parser = createCodexParser()
    const session = runCliSession(CAT, [file], workDir, (line) => parser.parse(line))
    const collector = startCollecting(session)
    await collector.done

    expect(collector.events.filter((e) => e.type === 'error')).toHaveLength(1)
    expect(collector.events.find((e) => e.type === 'error')).toMatchObject({ code: 'codex.malformed-json' })
    expect(collector.events.at(-1)).toMatchObject({ type: 'turn.done', stopReason: 'end' })
  })

  it('emits nothing but a terminal event when no parser is supplied', async () => {
    const session = runCliSession(CAT, [CODEX_FIXTURE], workDir)
    const collector = startCollecting(session)
    await collector.done

    expect(collector.events).toHaveLength(1)
    expect(collector.events[0]).toMatchObject({ type: 'turn.done', stopReason: 'end' })
  })
})

describe('runCliSession lifecycle', () => {
  it('close() reaps a still-running child and ends the iterable', async () => {
    const session = runCliSession(CAT, [], workDir, echoLines)
    const collector = startCollecting(session)
    await session.close()
    await collector.done
    expect(collector.events.at(-1)).toMatchObject({ type: 'turn.done', stopReason: 'cancelled' })
  })

  it('close() is safe after the child already exited', async () => {
    const session = runCliSession(CAT, [CODEX_FIXTURE], workDir, echoLines)
    const collector = startCollecting(session)
    await collector.done
    await expect(session.close()).resolves.toBeUndefined()
    await expect(session.cancel()).resolves.toBeUndefined()
  })
})

describe('startLazyCliSession turn handoff', () => {
  it.each([true, false])(
    'allows the next turn at completion without overlapping children (provider completion: %s)',
    async (providerCompletion) => {
      const history = path.join(workDir, `handoff-${providerCompletion}.txt`)
      const script = `
        const fs = require('node:fs')
        fs.appendFileSync(process.argv[1], 'start\\n')
        console.log(JSON.stringify({ type: 'thread.started', thread_id: '${THREAD}' }))
        console.log(JSON.stringify({ type: 'turn.started' }))
        ${providerCompletion ? "console.log(JSON.stringify({ type: 'turn.completed' }))" : ''}
        setTimeout(() => fs.appendFileSync(process.argv[1], 'exit\\n'), 100)
      `
      const session = startLazyCliSession({
        bin: process.execPath,
        cwd: workDir,
        createParser() {
          const parser = createCodexParser()
          return { parse: (line) => parser.parse(line), providerSessionId: () => parser.threadId() }
        },
        plan: (_prompt, providerSessionId) => ({
          args: ['-e', script, history],
          promptOnStdin: providerSessionId === undefined
        })
      })
      const handoff = (async () => {
        for await (const event of session.events) {
          if (event.type === 'turn.done') {
            await session.send('second')
            return
          }
        }
        throw new Error('session ended before the first turn completed')
      })()

      try {
        await Promise.all([session.send('first'), handoff])
        expect((await readFile(history, 'utf8')).trim().split('\n')).toEqual([
          'start',
          'exit',
          'start',
          'exit'
        ])
      } finally {
        await session.close()
        await handoff.catch(() => undefined)
      }
    }
  )
})
