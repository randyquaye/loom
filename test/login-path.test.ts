import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { adoptLoginPath } from '../src/main/env/login-path'

/** launchd's PATH for an app opened from the Dock, Finder or Spotlight. */
const BARE = '/usr/bin:/bin:/usr/sbin:/sbin'

function fakeShell(body: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'loom-shell-')), 'shell')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

/** Agent CLIs are found by name, so a GUI-launched app must still see where installers put them. */
describe('adoptLoginPath', () => {
  it('puts the login shell PATH first even when rc files print around it', async () => {
    const shell = fakeShell(
      `echo 'motd: welcome back'\nprintf '__LOOM_PATH__/opt/tools/bin:/usr/bin__LOOM_PATH__'\necho 'rc: done'`
    )
    const env: NodeJS.ProcessEnv = { SHELL: shell, HOME: '/Users/someone', PATH: BARE }
    await adoptLoginPath(env)
    const dirs = env.PATH?.split(':') ?? []
    expect(dirs[0]).toBe('/opt/tools/bin')
    expect(dirs).toEqual(expect.arrayContaining(['/bin', '/Users/someone/.local/bin', '/opt/homebrew/bin']))
    expect(dirs.filter((d) => d === '/usr/bin')).toHaveLength(1)
  })

  it('falls back to the usual install folders when the shell fails or hangs', async () => {
    for (const body of ['exit 3', 'sleep 5']) {
      const env: NodeJS.ProcessEnv = { SHELL: fakeShell(body), HOME: '/Users/someone', PATH: BARE }
      await adoptLoginPath(env, { timeoutMs: 300 })
      expect(env.PATH?.split(':')).toEqual([
        ...BARE.split(':'),
        '/Users/someone/.local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        '/usr/local/bin'
      ])
    }
  })
})
