import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTerminal, destroyTerminal, setTerminalSink, writeTerminal } from '../src/main/pty'
import { TERMINAL_DATA_CHANNEL } from '../src/shared/ipc-contract'

describe('pty terminal', () => {
  it('spawns a shell in the given cwd and streams its output', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'loom-pty-'))
    const chunks: string[] = []
    let id = ''
    setTerminalSink((channel, push) => {
      if (channel === TERMINAL_DATA_CHANNEL && 'data' in push && push.id === id) chunks.push(push.data)
    })
    id = createTerminal(cwd)
    writeTerminal(id, 'echo loom-pty-ok\r')

    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !chunks.join('').includes('loom-pty-ok')) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    destroyTerminal(id)
    expect(chunks.join('')).toContain('loom-pty-ok')
  }, 15000)
})
