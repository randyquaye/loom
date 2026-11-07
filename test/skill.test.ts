import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildClaudeArgs } from '../src/main/agents/cli/args'
import { LOOM_SKILL_MD, materializeLoomSkill, SKILL_FACTS } from '../src/main/agents/skill'

describe('loom skill', () => {
  it('materializes a claude-plugin-shaped skill directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'loom-skill-'))

    const dir = await materializeLoomSkill(root)

    expect(await readFile(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).toContain(
      '"name": "loom"'
    )
    const skill = await readFile(path.join(dir, 'skills', 'loom', 'SKILL.md'), 'utf8')
    expect(skill).toContain(SKILL_FACTS)
    expect(LOOM_SKILL_MD).toContain('LOOM_PORT')
  })

  it('passes --plugin-dir to claude only when set', () => {
    const withPlugin = buildClaudeArgs({
      workspaceId: 'w',
      worktreePath: '/tmp/wt',
      model: 'sonnet',
      effort: 'medium',
      systemPromptAppend: 'x',
      pluginDir: '/tmp/loom-skill'
    })
    expect(withPlugin).toContain('--plugin-dir=/tmp/loom-skill')

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
