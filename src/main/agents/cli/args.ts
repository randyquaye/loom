import path from 'node:path'
import type { Effort, SessionOpts } from '../../../shared/models'
import { findModel } from './catalog'

/**
 * Raised for renderer-supplied session options that must never reach an argv
 * array. `startSession` rejects with this instead of spawning.
 */
export class CliArgsError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CliArgsError'
    this.code = code
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** codex and claude also accept a session *name*; the charset stays narrow so a
 * name can never be re-read as a flag by the CLI's own argument parser. */
const SESSION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_SYSTEM_PROMPT_CHARS = 32_000

export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id) || SESSION_NAME_RE.test(id)
}

export function assertSessionId(id: string): string {
  if (!isValidSessionId(id)) {
    throw new CliArgsError(
      'bad-session-id',
      `session id is not a UUID or a valid thread name: ${JSON.stringify(id)}`
    )
  }
  return id
}

/**
 * Single gate between renderer-supplied SessionOpts and an argv array: the model
 * must be in the pinned catalog, the effort must be one that model advertises,
 * and the worktree path must be absolute (it becomes the child's cwd).
 */
export function assertSessionOpts(backend: 'codex' | 'claude', opts: SessionOpts): void {
  const model = findModel(backend, opts.model)
  if (!model) {
    throw new CliArgsError('unknown-model', `${backend} model not in catalog: ${JSON.stringify(opts.model)}`)
  }
  if (!model.efforts.includes(opts.effort)) {
    throw new CliArgsError(
      'unsupported-effort',
      `${backend} model ${model.id} does not support effort ${JSON.stringify(opts.effort)}`
    )
  }
  if (
    typeof opts.worktreePath !== 'string' ||
    opts.worktreePath.length === 0 ||
    !path.isAbsolute(opts.worktreePath)
  ) {
    throw new CliArgsError(
      'bad-worktree-path',
      `worktreePath must be an absolute path: ${JSON.stringify(opts.worktreePath)}`
    )
  }
  if (
    typeof opts.systemPromptAppend !== 'string' ||
    opts.systemPromptAppend.length > MAX_SYSTEM_PROMPT_CHARS
  ) {
    throw new CliArgsError(
      'bad-system-prompt',
      'systemPromptAppend must be a string of at most 32000 characters'
    )
  }
  if (opts.resumeId !== undefined) assertSessionId(opts.resumeId)
  if (opts.pluginDir !== undefined && (typeof opts.pluginDir !== 'string' || opts.pluginDir.length > 4096)) {
    throw new CliArgsError('bad-plugin-dir', 'pluginDir must be a path of at most 4096 characters')
  }
}

/** codex takes effort as a TOML-parsed config override, not a dedicated flag. */
export function codexEffortOverride(effort: Effort): string {
  return `model_reasoning_effort="${effort}"`
}

/**
 * Every valued option uses the `--flag=value` form so a value whose first
 * character is `-` cannot be re-parsed as a separate flag. Positional values go
 * behind an explicit `--` end-of-options marker (see `positionals`).
 */
export function buildCodexArgs(opts: SessionOpts): string[] {
  assertSessionOpts('codex', opts)
  return [
    'exec',
    '--json',
    `--model=${opts.model}`,
    // `-c`'s value already contains `=`, so `--config=<v>` would be ambiguous;
    // the value is a fixed literal prefix and can never start with `-`.
    '--config',
    codexEffortOverride(opts.effort)
  ]
}

export function buildClaudeArgs(opts: SessionOpts): string[] {
  assertSessionOpts('claude', opts)
  return [
    '-p',
    '--output-format=stream-json',
    // claude refuses stream-json under --print without --verbose.
    '--verbose',
    `--model=${opts.model}`,
    `--effort=${opts.effort}`,
    `--append-system-prompt=${opts.systemPromptAppend}`,
    ...(opts.pluginDir === undefined ? [] : [`--plugin-dir=${opts.pluginDir}`])
  ]
}

function positionals(values: string[]): string[] {
  return ['--', ...values]
}

export function buildCodexResumeArgs(sessionId: string, prompt: string): string[] {
  assertSessionId(sessionId)
  return ['exec', 'resume', '--json', ...positionals([sessionId, prompt])]
}

/** codex-native fork: same argv shape as resume, new thread id downstream. */
export function buildCodexForkArgs(sessionId: string, prompt: string): string[] {
  assertSessionId(sessionId)
  return ['exec', 'fork', '--json', ...positionals([sessionId, prompt])]
}

export function buildClaudeResumeArgs(sessionId: string, prompt: string): string[] {
  assertSessionId(sessionId)
  return ['-p', '--output-format=stream-json', '--verbose', `--resume=${sessionId}`, ...positionals([prompt])]
}
