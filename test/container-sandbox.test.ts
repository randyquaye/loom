import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createContainerRuntime } from '../src/main/runtime/container'
import type { WorkspaceRuntime } from '../src/main/runtime/types'

const IMAGE = process.env['LOOM_WORKSPACE_IMAGE'] ?? 'loom-workspace:latest'

/** Needs a Docker daemon and the workspace image (pnpm workspace-image); without them it skips. */
function imageAvailable(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!imageAvailable())('a workspace container', () => {
  let root: string
  let checkout: string
  let home: string
  let runtime: WorkspaceRuntime

  beforeAll(async () => {
    root = await mkdtemp(path.join(await realpath(tmpdir()), 'loom-sbx-'))
    checkout = path.join(root, 'workspaces', 'demo', 'boxed')
    home = path.join(root, 'home')
    await mkdir(checkout, { recursive: true })
    runtime = createContainerRuntime({
      name: `loom-ws-sandbox-test-${process.pid}`,
      image: IMAGE,
      checkoutPath: checkout,
      homePath: home,
      seccompProfilePath: path.join(root, 'workspace-seccomp.json'),
      memory: '1g',
      cpus: '1'
    })
    await runtime.ensureRunning()
  }, 60_000)

  afterAll(async () => {
    await runtime?.stop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  }, 60_000)

  it("lets Codex's own sandbox start, and that sandbox keeps writes inside the checkout", async () => {
    // Codex builds its sandbox from Linux namespaces, which Docker's stock syscall filter
    // refuses. When it cannot start, Codex has to ask the user before every single command.
    const sandboxed = (script: string) =>
      runtime.exec('codex', ['sandbox', '-c', 'sandbox_mode=workspace-write', '--', 'sh', '-c', script], {
        cwd: checkout,
        timeoutMs: 30_000
      })

    await sandboxed('echo inside > allowed.txt')
    await expect(sandboxed('echo outside > "$HOME/escaped.txt"')).rejects.toThrow()

    expect(await readFile(path.join(checkout, 'allowed.txt'), 'utf8')).toBe('inside\n')
    expect(await stat(path.join(home, 'escaped.txt')).catch(() => null)).toBeNull()
  }, 90_000)
})
