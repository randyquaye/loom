import type Database from 'better-sqlite3'
import type { BotWorkspace } from '../../shared/ipc-contract'
import { signInIsLive } from '../auth/tokens'
import { getProjectOrThrow } from '../db/repos/projects'
import { getWorkspace } from '../db/repos/workspaces'
import { handle, type Caller } from '../ipc/registry'
import type { Logins } from '../logins/service'
import type { OrgService } from '../org/service'
import type { AccessRules } from '../runner/access'
import { listSessions } from '../sessions/service'
import type { BotGithub } from './github'
import type { BotInvocations } from './invocations'
import type { BotService } from './repository'

interface BotHandlerOptions {
  db: Database.Database
  org: OrgService
  bots: BotService
  invocations: BotInvocations
  github: BotGithub
  logins: Logins | null
  access: AccessRules
  changed(botId: string, stop: boolean): Promise<void> | void
}

export function registerBotHandlers(options: BotHandlerOptions): void {
  const { db, org, bots, invocations, github, access } = options
  const actor = (caller: Caller | undefined) => {
    if (caller === undefined) throw new Error('Sign in to the organization first')
    return caller.userId
  }
  function administrator(caller: Caller | undefined, botId: string) {
    const id = actor(caller)
    if (caller?.signInId !== undefined && !signInIsLive({ db, isAdmitted: org.active }, caller.signInId))
      throw new Error('This administrator sign-in is no longer valid')
    org.requireOwner(id)
    return bots.get(id, botId)
  }
  function keeper(): Logins {
    if (options.logins === null) throw new Error('Bot credentials require the runner credential service')
    return options.logins
  }

  handle('bots:list', (_input, caller) => bots.list(actor(caller)))
  handle('bots:create', async ({ slug, config }, caller) => {
    const bot = bots.create(actor(caller), slug, config)
    await options.changed(bot.id, false)
    return bot
  })
  handle('bots:update', async ({ botId, config, enabled, revision }, caller) => {
    const previous = administrator(caller, botId)
    const next = bots.update(actor(caller), botId, config, enabled, revision)
    const stop =
      !enabled || JSON.stringify(previous.config.repositories) !== JSON.stringify(next.config.repositories)
    await options.changed(botId, stop)
    return next
  })
  handle('bots:grants', ({ botId }, caller) => bots.grants(actor(caller), botId))
  handle('bots:setGrant', async ({ botId, userId, access: granted }, caller) => {
    const previous = bots.grants(actor(caller), botId).find((grant) => grant.userId === userId)?.access
    bots.setGrant(actor(caller), botId, userId, granted)
    await options.changed(botId, previous === 'control' && granted !== 'control')
  })
  handle('bots:logins', ({ botId }, caller) => {
    administrator(caller, botId)
    return keeper().status(botId)
  })
  handle('bots:connectClaude', ({ botId }, caller) => {
    administrator(caller, botId)
    throw new Error('Connect Claude in Organization Subscriptions and grant the bot shared capacity')
  })
  handle('bots:connectCodex', ({ botId }, caller) => {
    administrator(caller, botId)
    throw new Error('Connect Codex in Organization Subscriptions and grant the bot shared capacity')
  })
  handle('bots:setGithub', ({ botId, ...credentials }, caller) => {
    administrator(caller, botId)
    return github
      .configure(botId, credentials, () => {
        administrator(caller, botId)
      })
      .then(async () => {
        administrator(caller, botId)
        await options.changed(botId, true)
      })
  })
  handle('bots:disconnect', ({ botId, provider }, caller) => {
    administrator(caller, botId)
    if (provider !== 'github')
      throw new Error('Manage provider accounts and bot grants in Organization Subscriptions')
    return keeper()
      .disconnect(botId, provider, () => {
        administrator(caller, botId)
      })
      .then(() => options.changed(botId, true))
  })
  handle('bots:invoke', (input, caller) => invocations.invoke(actor(caller), input))
  handle('bots:invocations', ({ botId }, caller) => invocations.list(actor(caller), botId))
  handle('bots:open', ({ invocationId }, caller): BotWorkspace => {
    const userId = actor(caller)
    const invocation = invocations.get(userId, invocationId)
    const workspace = getWorkspace(db, invocation.workspaceId)
    if (workspace !== null && !access.mayViewWorkspace(userId, workspace.id))
      throw new Error('Bot workspace was not found')
    const permission = bots.get(userId, invocation.botId).access
    return {
      invocation,
      project: workspace === null ? null : getProjectOrThrow(db, workspace.projectId),
      workspace:
        workspace === null || permission === null
          ? null
          : {
              ...workspace,
              bot: {
                id: invocation.botId,
                access: access.mayControlWorkspace(userId, workspace.id) ? 'control' : 'view'
              }
            },
      session:
        workspace === null
          ? null
          : (listSessions(db, workspace.id).find((session) => session.id === invocation.sessionId) ?? null)
    }
  })
}
