import * as pty from 'node-pty'
import { spawnChild, terminateChild } from '../agents/cli/spawn'
import { collect } from './exec'
import type { WorkspaceRuntime } from './types'

/** Processes start on the machine Loom itself runs on: the behaviour before containers. */
export const machineRuntime: WorkspaceRuntime = {
  async ensureRunning() {},

  exec(file, args, opts = {}) {
    return collect(this.spawn(file, args, opts), file, opts)
  },

  spawn(file, args, opts = {}) {
    const child = spawnChild(file, [...args], opts.cwd, opts.env)
    return { child, terminate: () => terminateChild(child) }
  },

  openTerminal(opts = {}) {
    const terminal = pty.spawn(process.env['SHELL'] ?? '/bin/zsh', [], {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: { ...process.env, ...opts.env } as Record<string, string>
    })
    return { pty: terminal, terminate: () => terminal.kill() }
  },

  // Only a container is ever stopped for being idle, so nothing asks this of the machine.
  async runningCommand() {
    return false
  },

  async stop() {}
}
