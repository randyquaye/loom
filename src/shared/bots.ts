import { z } from 'zod'
import { CLAUDE_MODES, CODEX_MODES, DEFAULT_AGENT_MODES, EFFORTS } from './models'

export const botAccessSchema = z.enum(['view', 'control'])
export type BotAccess = z.infer<typeof botAccessSchema>
export const botSlugSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/, 'Use a short lowercase bot name')

/** Exact GitHub repositories only; grants never include arbitrary hosts, paths, or wildcards. */
export function canonicalBotRepository(input: string): string {
  let repository = input.trim()
  if (/[\\\u0000-\u001f\u007f]/.test(repository) || /\/(?:\.|%2e){1,2}(?:\/|$)/i.test(repository)) {
    throw new Error('Choose a repository without path traversal or control characters')
  }
  if (repository.startsWith('git@github.com:')) repository = repository.slice('git@github.com:'.length)
  else if (/^(https|ssh):\/\//.test(repository)) {
    const url = new URL(repository)
    if (
      url.hostname !== 'github.com' ||
      url.port !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      (url.protocol === 'https:' && url.username !== '') ||
      (url.protocol === 'ssh:' && url.username !== 'git')
    )
      throw new Error('Choose an exact GitHub owner/repository without credentials or extra URL parts')
    repository = url.pathname.slice(1)
  }
  repository = repository.replace(/\/$/, '').replace(/\.git$/, '')
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
    ['.', '..'].includes(repository.split('/')[1]!)
  ) {
    throw new Error('Choose an exact GitHub owner/repository')
  }
  return repository.toLowerCase()
}

export function botRepositoryUrl(repository: string): string {
  return `https://github.com/${canonicalBotRepository(repository)}.git`
}

const repositorySchema = z
  .string()
  .max(512)
  .transform((input, context) => {
    try {
      return canonicalBotRepository(input)
    } catch {
      context.addIssue({ code: 'custom', message: 'Choose an exact GitHub owner/repository' })
      return z.NEVER
    }
  })

export const botSkillSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
    instructions: z.string().trim().min(1).max(8000)
  })
  .strict()
export type BotSkill = z.infer<typeof botSkillSchema>

export const botConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    instructions: z.string().trim().min(1).max(16000),
    backend: z.enum(['claude', 'codex']),
    model: z.string().trim().min(1).max(128),
    effort: z.enum(EFFORTS),
    repositories: z
      .array(repositorySchema)
      .min(1)
      .max(32)
      .transform((repositories) => [...new Set(repositories)]),
    skills: z.array(botSkillSchema).max(16),
    modes: z.object({ claude: z.enum(CLAUDE_MODES), codex: z.enum(CODEX_MODES) }).strict()
  })
  .strict()
  .refine((config) => new Set(config.repositories.map((repository) => repository.split('/')[0])).size <= 1, {
    message: 'Use repositories from one GitHub installation owner',
    path: ['repositories']
  })
  .refine(
    (config) =>
      config.instructions.length +
        config.skills.reduce((size, skill) => size + skill.instructions.length + skill.name.length, 0) <=
      24000,
    'Bot instructions and skills must fit within 24000 characters'
  )
  .refine(
    (config) => new Set(config.skills.map((skill) => skill.name.toLowerCase())).size === config.skills.length,
    'Skill names must be unique'
  )
export type BotConfig = z.infer<typeof botConfigSchema>

export interface BotRecord {
  id: string
  slug: string
  revision: number
  enabled: boolean
  config: BotConfig
  createdAt: number
  access: BotAccess | null
}

export interface BotGrant {
  userId: string
  email: string
  access: BotAccess
}

/** Provisioning/delivery phase only; conversational outcomes remain session events. */
export type BotInvocationState = 'preparing' | 'ready' | 'failed' | 'interrupted'
export interface BotInvocation {
  id: string
  botId: string
  requesterId: string
  requestKey: string
  fingerprint: string
  configRevision: number
  config: BotConfig
  repository: string
  prompt: string
  workspaceId: string
  sessionId: string
  messageId: string
  state: BotInvocationState
  error: string | null
  createdAt: number
  updatedAt: number
}

/** Robot uses exactly the same configuration and execution path as any organization bot. */
export function robotConfig(): BotConfig {
  return {
    name: 'Robot',
    instructions:
      'Help with coding, explanations, investigations, operations, and requested pull requests. Work within granted repositories and capabilities. Report evidence, progress, failures, and results clearly. Ask for human input when required; never invent credentials, permissions, or successful outcomes.',
    backend: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    repositories: [],
    skills: [],
    modes: { ...DEFAULT_AGENT_MODES }
  }
}
