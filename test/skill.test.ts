import { describe, expect, it } from 'vitest'
import { buildClaudeArgs } from '../src/main/agents/cli/args'

describe('plugin arguments', () => {
  it('passes --plugin-dir to claude only when set', () => {
    const withPlugin = buildClaudeArgs({
      workspaceId: 'w',
      worktreePath: '/tmp/wt',
      model: 'sonnet',
      effort: 'medium',
      systemPromptAppend: 'x',
      pluginDir: '/tmp/example-plugin'
    })
    expect(withPlugin).toContain('--plugin-dir=/tmp/example-plugin')

    const without = buildClaudeArgs({
      workspaceId: 'w',
      worktreePath: '/tmp/wt',
      model: 'sonnet',
      effort: 'medium',
      systemPromptAppend: 'x'
    })
    expect(without.some((arg) => arg.startsWith('--plugin-dir'))).toBe(false)
  })
})
