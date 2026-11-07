import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface RunAction {
  id: string
  command: string
  icon: string | null
  isDefault: boolean
}

export interface RepoSettings {
  setup: string | null
  archive: string | null
  runMode: 'concurrent' | 'nonconcurrent'
  run: RunAction[]
  fileIncludeGlobs: string[]
}

export const DEFAULT_SETTINGS: RepoSettings = {
  setup: null,
  archive: null,
  runMode: 'concurrent',
  run: [],
  fileIncludeGlobs: []
}

const SETTINGS_REL_PATH = path.join('.loom', 'settings.toml')

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseStringArray(value: string): string[] {
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '')
  if (inner.trim() === '') return []
  return inner
    .split(',')
    .map((part) => unquote(part))
    .filter((part) => part !== '')
}

/**
 * Deliberately small TOML subset: comments, `[scripts]` and `[scripts.run.<id>]`
 * tables, string/boolean values and string arrays. Anything else is ignored,
 * so an unsupported key can never break workspace creation.
 */
export function parseSettingsToml(text: string): RepoSettings {
  const settings: RepoSettings = { ...DEFAULT_SETTINGS, run: [], fileIncludeGlobs: [] }
  let table: { kind: 'root' } | { kind: 'scripts' } | { kind: 'run'; id: string } = { kind: 'root' }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim()
      if (name === 'scripts') table = { kind: 'scripts' }
      else if (name.startsWith('scripts.run.')) {
        const id = name
          .slice('scripts.run.'.length)
          .trim()
          .replace(/^["']|["']$/g, '')
        if (id !== '') {
          table = { kind: 'run', id }
          if (!settings.run.some((action) => action.id === id)) {
            settings.run.push({ id, command: '', icon: null, isDefault: false })
          }
        }
      } else table = { kind: 'root' }
      continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (table.kind === 'root' && key === 'file_include_globs') {
      settings.fileIncludeGlobs = parseStringArray(value)
    } else if (table.kind === 'scripts') {
      if (key === 'setup') settings.setup = unquote(value)
      else if (key === 'archive') settings.archive = unquote(value)
      else if (key === 'run_mode') {
        settings.runMode = unquote(value) === 'nonconcurrent' ? 'nonconcurrent' : 'concurrent'
      }
    } else if (table.kind === 'run') {
      const runId = table.id
      const action = settings.run.find((entry) => entry.id === runId)
      if (action === undefined) continue
      if (key === 'command') action.command = unquote(value)
      else if (key === 'icon') action.icon = unquote(value)
      else if (key === 'default') action.isDefault = value === 'true'
    }
  }
  settings.run = settings.run.filter((action) => action.command !== '')
  return settings
}

export async function readRepoSettings(repoPath: string): Promise<RepoSettings> {
  const text = await readFile(path.join(repoPath, SETTINGS_REL_PATH), 'utf8').catch(() => null)
  return text === null ? { ...DEFAULT_SETTINGS, run: [], fileIncludeGlobs: [] } : parseSettingsToml(text)
}
