import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  botAccessSchema,
  botConfigSchema,
  botSlugSchema,
  type BotAccess,
  type BotConfig,
  type BotGrant,
  type BotRecord
} from '../../shared/bots'
import { findModel } from '../agents/cli/catalog'
import type { OrgService } from '../org/service'

const BOT_COLUMNS = 'b.user_id AS id,b.slug,b.revision,b.enabled,b.config,b.created_at AS createdAt'
interface BotRow {
  id: string
  slug: string
  revision: number
  enabled: number
  config: string
  createdAt: number
}

function record(row: BotRow, access: BotAccess | null = null): BotRecord {
  return { ...row, enabled: row.enabled === 1, config: botConfigSchema.parse(JSON.parse(row.config)), access }
}

/** Internal configuration lookup never grants the caller permission to inspect its workspaces. */
export function readBot(db: Database.Database, id: string): BotRecord | null {
  const row = db
    .prepare(
      `SELECT ${BOT_COLUMNS} FROM bots b JOIN org_members m ON m.user_id=b.user_id
    WHERE b.user_id=? AND m.kind='bot' AND m.state='active'`
    )
    .get(id) as BotRow | undefined
  return row === undefined ? null : record(row)
}

export type BotService = ReturnType<typeof createBotService>

export function createBotService({ db, org }: { db: Database.Database; org: OrgService }) {
  function human(actorId: string): void {
    const member = org.member(actorId)
    if (member?.kind !== 'human' || member.state !== 'active') {
      throw new Error('An active human organization member is required')
    }
  }
  function administrator(actorId: string): void {
    human(actorId)
    org.requireOwner(actorId)
  }
  function grant(actorId: string, botId: string): BotAccess | null {
    const found = db
      .prepare('SELECT access FROM bot_grants WHERE bot_id=? AND user_id=?')
      .get(botId, actorId) as { access: BotAccess } | undefined
    return found?.access ?? null
  }
  function get(actorId: string, botId: string): BotRecord {
    human(actorId)
    const bot = readBot(db, botId)
    const access = grant(actorId, botId)
    if (bot === null || (access === null && !org.owner(actorId))) throw new Error('Bot was not found')
    return { ...bot, access }
  }
  function configuration(input: BotConfig): BotConfig {
    const config = botConfigSchema.parse(input)
    const model = findModel(config.backend, config.model)
    if (model === undefined || !model.efforts.includes(config.effort)) {
      throw new Error('Choose a supported bot model and effort')
    }
    return config
  }
  function audit(actorId: string, action: string, botId: string, detail: unknown): void {
    db.prepare('INSERT INTO org_admin_log(actor_id,action,subject,at,detail) VALUES (?,?,?,?,?)').run(
      actorId,
      action,
      botId,
      Date.now(),
      JSON.stringify(detail)
    )
  }

  return {
    get,
    list(actorId: string): BotRecord[] {
      human(actorId)
      const rows = db
        .prepare(
          `SELECT ${BOT_COLUMNS} FROM bots b JOIN org_members m ON m.user_id=b.user_id
        WHERE m.kind='bot' AND m.state='active' ORDER BY b.created_at,b.user_id`
        )
        .all() as BotRow[]
      return rows.flatMap((row) => {
        const access = grant(actorId, row.id)
        return access !== null || org.owner(actorId) ? [record(row, access)] : []
      })
    },
    create(actorId: string, slug: string, input: BotConfig): BotRecord {
      return db.transaction(() => {
        administrator(actorId)
        const name = botSlugSchema.parse(slug)
        const config = configuration(input)
        if (db.prepare('SELECT 1 FROM bots WHERE slug=?').get(name) !== undefined)
          throw new Error('A bot already uses that name')
        const id = randomUUID()
        const now = Date.now()
        db.prepare('INSERT INTO users(id,email,created_at) VALUES (?,?,?)').run(
          id,
          `bot-${id}@loom.invalid`,
          now
        )
        db.prepare(
          "INSERT INTO org_members(user_id,role,kind,state,joined_at) VALUES (?,'member','bot','active',?)"
        ).run(id, now)
        db.prepare(
          'INSERT INTO bots(user_id,slug,revision,enabled,config,created_by,created_at) VALUES (?,?,1,1,?,?,?)'
        ).run(id, name, JSON.stringify(config), actorId, now)
        db.prepare("INSERT INTO bot_grants(bot_id,user_id,access) VALUES (?,?,'control')").run(id, actorId)
        audit(actorId, 'bot.create', id, { slug: name, revision: 1 })
        return get(actorId, id)
      })()
    },
    update(
      actorId: string,
      botId: string,
      input: BotConfig,
      enabled: boolean,
      expectedRevision: number
    ): BotRecord {
      return db.transaction(() => {
        administrator(actorId)
        const current = get(actorId, botId)
        if (current.revision !== expectedRevision)
          throw new Error('Bot configuration changed; reload its current revision')
        if (typeof enabled !== 'boolean') throw new Error('Choose whether this bot is enabled')
        const config = configuration(input)
        db.prepare('UPDATE bots SET config=?,enabled=?,revision=revision+1 WHERE user_id=?').run(
          JSON.stringify(config),
          Number(enabled),
          botId
        )
        audit(actorId, 'bot.update', botId, { revision: current.revision + 1, enabled })
        return get(actorId, botId)
      })()
    },
    grants(actorId: string, botId: string): BotGrant[] {
      administrator(actorId)
      get(actorId, botId)
      return db
        .prepare(
          `SELECT g.user_id AS userId,u.email,g.access FROM bot_grants g
        JOIN org_members m ON m.user_id=g.user_id JOIN users u ON u.id=g.user_id
        WHERE g.bot_id=? AND m.kind='human' AND m.state='active' ORDER BY g.user_id`
        )
        .all(botId) as BotGrant[]
    },
    setGrant(actorId: string, botId: string, userId: string, access: BotAccess | null): void {
      db.transaction(() => {
        administrator(actorId)
        get(actorId, botId)
        const member = org.member(userId)
        if (member?.kind !== 'human') throw new Error('Bot access can only be granted to human members')
        if (access !== null) {
          if (member.state !== 'active') throw new Error('An active member is required')
          botAccessSchema.parse(access)
          db.prepare(
            'INSERT INTO bot_grants(bot_id,user_id,access) VALUES (?,?,?) ON CONFLICT(bot_id,user_id) DO UPDATE SET access=excluded.access'
          ).run(botId, userId, access)
        } else db.prepare('DELETE FROM bot_grants WHERE bot_id=? AND user_id=?').run(botId, userId)
        audit(actorId, 'bot.grant', botId, { userId, access })
      })()
    },
    assertControl(actorId: string, botId: string): BotRecord {
      const bot = get(actorId, botId)
      if (bot.access !== 'control') throw new Error('Bot control access is required')
      if (!bot.enabled) throw new Error('This bot is disabled')
      return bot
    }
  }
}
