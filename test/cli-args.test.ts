import { describe, expect, it } from 'vitest'
import {
  assertSessionOpts,
  buildClaudeArgs,
  buildClaudeResumeArgs,
  buildCodexArgs,
  buildCodexForkArgs,
  buildCodexResumeArgs,
  CliArgsError,
  codexEffortOverride,
  isValidSessionId
} from '../src/main/agents/cli/args'
import { CLAUDE_MODELS, CODEX_MODELS } from '../src/main/agents/cli/catalog'
import type { SessionOpts } from '../src/shared/models'

const WORKTREE = '/Users/randyquaye/Library/Application Support/Loom/workspaces/loom/p3-cli'
const UUID = '019c1f3a-7d2b-4a51-9c0e-2b6f8a4d1e77'

function codexOpts(overrides: Partial<SessionOpts> = {}): SessionOpts {
  return {
    workspaceId: 'ws_1',
    worktreePath: WORKTREE,
    model: 'gpt-6.1-sol',
    effort: 'high',
    systemPromptAppend: 'Reference files as repo-relative paths with an optional :LINE suffix.',
    ...overrides
  }
}

function claudeOpts(overrides: Partial<SessionOpts> = {}): SessionOpts {
  return codexOpts({ model: 'sonnet', ...overrides })
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return e instanceof CliArgsError ? e.code : 'not-a-CliArgsError'
  }
  return 'did-not-throw'
}

describe('buildCodexArgs', () => {
  it('emits exec --json with the model flag and the reasoning-effort override', () => {
    expect(buildCodexArgs(codexOpts())).toEqual([
      'exec',
      '--json',
      '--model=gpt-6.1-sol',
      '--config',
      'model_reasoning_effort="high"'
    ])
  })

  it('tracks the effort through the -c override', () => {
    expect(buildCodexArgs(codexOpts({ effort: 'low' }))).toContain('model_reasoning_effort="low"')
    expect(codexEffortOverride('medium')).toBe('model_reasoning_effort="medium"')
  })

  it('keeps the model as a separate argv element, never a shell string', () => {
    const args = buildCodexArgs(codexOpts())
    expect(args).not.toContain(expect.stringContaining(' '))
    expect(args.some((a) => a.includes('$') || a.includes('`') || a.includes(';'))).toBe(false)
  })
})

describe('buildClaudeArgs', () => {
  it('emits print mode, stream-json, model and the appended system prompt', () => {
    const args = buildClaudeArgs(claudeOpts())
    expect(args).toEqual([
      '-p',
      '--output-format=stream-json',
      '--verbose',
      '--model=sonnet',
      '--effort=high',
      '--append-system-prompt=Reference files as repo-relative paths with an optional :LINE suffix.'
    ])
  })

  it('uses --flag=value so a leading dash in the prompt cannot become a flag', () => {
    const args = buildClaudeArgs(claudeOpts({ systemPromptAppend: '--dangerously-skip-permissions' }))
    expect(args).toContain('--append-system-prompt=--dangerously-skip-permissions')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('survives an empty appended prompt', () => {
    expect(buildClaudeArgs(claudeOpts({ systemPromptAppend: '' }))).toContain('--append-system-prompt=')
  })
})

describe('resume and fork builders', () => {
  it('builds codex resume argv with the session model and effort, behind an end-of-options marker', () => {
    expect(buildCodexResumeArgs(codexOpts(), UUID, 'continue the refactor')).toEqual([
      'exec',
      'resume',
      ...buildCodexArgs(codexOpts()).slice(1),
      '--',
      UUID,
      'continue the refactor'
    ])
  })

  it('builds codex fork argv behind an end-of-options marker', () => {
    expect(buildCodexForkArgs(UUID, 'branch from here')).toEqual([
      'exec',
      'fork',
      '--json',
      '--',
      UUID,
      'branch from here'
    ])
  })

  it('builds claude resume argv with the first-turn flags, --resume= and the prompt as a positional', () => {
    expect(buildClaudeResumeArgs(claudeOpts(), UUID, 'keep going')).toEqual([
      ...buildClaudeArgs(claudeOpts()),
      `--resume=${UUID}`,
      '--',
      'keep going'
    ])
  })

  it('neutralizes a prompt that starts with a dash', () => {
    const args = buildCodexResumeArgs(codexOpts(), UUID, '--json please')
    expect(args.indexOf('--')).toBeLessThan(args.indexOf('--json please'))
    expect(args[args.length - 1]).toBe('--json please')
  })
})

describe('isValidSessionId', () => {
  it('accepts UUIDs and narrow thread names', () => {
    expect(isValidSessionId(UUID)).toBe(true)
    expect(isValidSessionId('p3-cli-adapters.2')).toBe(true)
  })

  it('rejects anything that could be re-read as a flag or a shell fragment', () => {
    for (const bad of [
      '',
      '-last',
      '--json',
      'a b',
      'id;rm -rf /',
      'x'.repeat(65),
      'a\nb',
      '../etc/passwd'
    ]) {
      expect(isValidSessionId(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('assertSessionOpts', () => {
  it('accepts a catalogued model and effort', () => {
    expect(() => assertSessionOpts('codex', codexOpts())).not.toThrow()
    expect(() => assertSessionOpts('claude', claudeOpts())).not.toThrow()
  })

  it('rejects a model that is not in the catalog', () => {
    expect(codeOf(() => buildCodexArgs(codexOpts({ model: 'gpt-9-imaginary' })))).toBe('unknown-model')
    expect(codeOf(() => buildClaudeArgs(claudeOpts({ model: 'sonnet; rm -rf /' })))).toBe('unknown-model')
  })

  it('rejects a model catalogued for the other backend', () => {
    expect(codeOf(() => buildCodexArgs(codexOpts({ model: 'sonnet' })))).toBe('unknown-model')
    expect(codeOf(() => buildClaudeArgs(claudeOpts({ model: 'gpt-6.1-sol' })))).toBe('unknown-model')
  })

  it('rejects an effort the model does not advertise', () => {
    expect(codeOf(() => buildCodexArgs(codexOpts({ effort: 'minimal' })))).toBe('unsupported-effort')
    expect(codeOf(() => buildClaudeArgs(claudeOpts({ effort: 'minimal' })))).toBe('unsupported-effort')
  })

  it('rejects a relative or empty worktree path', () => {
    expect(codeOf(() => buildCodexArgs(codexOpts({ worktreePath: 'relative/path' })))).toBe(
      'bad-worktree-path'
    )
    expect(codeOf(() => buildClaudeArgs(claudeOpts({ worktreePath: '' })))).toBe('bad-worktree-path')
  })

  it('rejects a resumeId that is not a UUID or thread name', () => {
    expect(codeOf(() => assertSessionOpts('codex', codexOpts({ resumeId: '--last' })))).toBe('bad-session-id')
  })

  it('rejects an oversized appended system prompt', () => {
    expect(codeOf(() => buildClaudeArgs(claudeOpts({ systemPromptAppend: 'x'.repeat(32_001) })))).toBe(
      'bad-system-prompt'
    )
  })

  it('catalogs every model with at least one effort', () => {
    for (const model of [...CODEX_MODELS, ...CLAUDE_MODELS]) {
      expect(model.efforts.length, model.id).toBeGreaterThan(0)
    }
  })
})
