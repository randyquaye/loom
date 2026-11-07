import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, parseSettingsToml, readRepoSettings } from '../src/main/config/repo-settings'

describe('parseSettingsToml', () => {
  it('reads setup, archive, run_mode, run actions and include globs', () => {
    const settings = parseSettingsToml(`
# team setup
file_include_globs = [".env*", "config/local.toml"]

[scripts]
setup = "pnpm install"
archive = "pnpm archive"
run_mode = "nonconcurrent"

[scripts.run.dev]
command = "pnpm dev --port $LOOM_PORT"
icon = "play"
default = true

[scripts.run.test]
command = 'pnpm test:watch'
`)
    expect(settings.setup).toBe('pnpm install')
    expect(settings.archive).toBe('pnpm archive')
    expect(settings.runMode).toBe('nonconcurrent')
    expect(settings.fileIncludeGlobs).toEqual(['.env*', 'config/local.toml'])
    expect(settings.run).toEqual([
      { id: 'dev', command: 'pnpm dev --port $LOOM_PORT', icon: 'play', isDefault: true },
      { id: 'test', command: 'pnpm test:watch', icon: null, isDefault: false }
    ])
  })

  it('ignores comments, blanks, unknown keys and command-less actions', () => {
    const settings = parseSettingsToml(`
[scripts]
# setup = "commented out"
unknown_key = 42

[scripts.run.empty]
icon = "play"
`)
    expect(settings.setup).toBeNull()
    expect(settings.run).toEqual([])
    expect(settings.runMode).toBe('concurrent')
  })

  it('returns defaults for a missing settings file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-settings-'))
    await mkdir(path.join(root, 'unused'), { recursive: true })
    expect(await readRepoSettings(root)).toEqual(DEFAULT_SETTINGS)
  })
})
